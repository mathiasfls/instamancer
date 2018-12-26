import {Browser, Headers, launch, Page, Request, Response} from "puppeteer";

import AwaitLock = require("await-lock");
import chalk from "chalk";
import * as _ from "lodash/object";
import {Logger} from "winston";

/**
 * The states of progress that the API can be in
 */
enum Progress {
    LAUNCHING = "Launching",
    OPENING = "Navigating",
    SCRAPING = "Scraping",
    BRANCHING = "Branching",
    GRAFTING = "Grafting",
    CLOSING = "Closing",

    PAUSED = "Paused",
    ABORTED = "Request aborted",
}

/**
 * A fixed-size queue of post ids
 */
class PostIdQueue {
    private ids: Set<string> = new Set<string>();

    /**
     * Add a post id to the queue. The least-recently inserted id is de-queued when it reaches max size
     * @return true if the id was already in the queue, false if not.
     */
    public enqueue(id: string): boolean {
        // Check if already in list
        const contains = this.ids.has(id);

        // Add id
        this.ids.add(id);

        // Return if id was already in list
        return contains;
    }
}

/**
 * Optional arguments for the API
 */
export interface IApiOptions {
    total?: number;
    headless?: boolean;
    logger?: Logger;
    silent?: boolean;
    sleepTime?: number;
    enableGrafting?: boolean;
    fullAPI?: boolean;
}

/**
 * An Instagram API object
 */
export class Instagram implements AsyncIterableIterator<object> {
    // Puppeteer state
    private browser: Browser;
    private page: Page;
    private readonly headless: boolean;

    // General information
    private readonly id: string;

    // List of scraped posts and lock
    private postBuffer: object[] = [];
    private postBufferLock: AwaitLock = new AwaitLock();

    // Request and Response buffers and locks
    private requestBuffer: Request[] = [];
    private requestBufferLock: AwaitLock = new AwaitLock();
    private responseBuffer: Response[] = [];
    private responseBufferLock: AwaitLock = new AwaitLock();

    // Get full amount of data from API
    private readonly fullAPI: boolean = false;
    private pagePromises: Array<Promise<void>> = [];

    // Grafting state
    private readonly enableGrafting: boolean = true;
    private graft: boolean = false;
    private lastURL: string;
    private lastHeaders: Headers;

    // Hibernation due to rate limiting
    private hibernate: boolean = false;
    private hibernationTime: number = 60 * 20;

    // The endpoint URL used for scraping
    private readonly url: string;

    // URL for API calls
    private readonly catchURL: string = "https://www.instagram.com/graphql/query";

    // Strings denoting the access methods of API objects
    private readonly pageQuery: string;
    private readonly edgeQuery: string;

    // Iteration state is finished
    private finished: boolean;

    // Cache of post ids
    private postIds: PostIdQueue;

    // Iteration variables
    private readonly total: number;
    private index: number = 0;
    private jumps: number = 0;
    private jumpMod: number = 100;

    // Output
    private readonly silent: boolean = false;
    private writeLock: AwaitLock = new AwaitLock();

    // Sleep time remaining
    private sleepRemaining: number = 0;

    // Length of time to sleep for
    private readonly sleepTime: number = 2;

    // Scraping paused
    private paused: boolean = false;

    // Logging object
    private logger: Logger;

    constructor(endpoint: string, id: string, pageQuery: string, edgeQuery: string, options: IApiOptions = {}) {
        this.id = id;
        this.total = options.total;
        this.url = endpoint + id;
        this.pageQuery = pageQuery;
        this.edgeQuery = edgeQuery;
        this.headless = options.headless;
        this.logger = options.logger;
        this.silent = options.silent;
        this.enableGrafting = options.enableGrafting;
        this.sleepTime = options.sleepTime;
        this.postIds = new PostIdQueue();
        this.fullAPI = options.fullAPI;
    }

    /**
     * Toggle pausing data collection
     */
    public pause() {
        this.paused = !this.paused;
    }

    /**
     * Generator of posts on page
     */
    public async* generator() {
        while (true) {
            // Get more posts
            await this.getNext();

            // Yield posts from buffer
            let post = await this.postPop();
            while (post) {
                yield post;
                post = await this.postPop();
            }

            // End loop when finished and posts in buffer exhausted
            if (this.finished) {
                break;
            }
        }
        await this.stop();

        // Add newline to end of output
        if (!this.silent) {
            process.stdout.write("\n");
        }
    }

    /**
     * Create the browser and page, then visit the url
     */
    private async constructPage() {
        // Browser args
        const args = [];
        if (process.env.NO_SANDBOX) {
            args.push("--no-sandbox");
            args.push("--disable-setuid-sandbox");
        }

        // Launch browser
        await this.progress(Progress.LAUNCHING);
        this.browser = await launch({
            args,
            headless: this.headless,
        });

        // New page
        this.page = await this.browser.newPage();
        await this.progress(Progress.OPENING);

        // Attempt to visit URL
        try {
            await this.page.goto(this.url);
        } catch (e) {
            // Log error and wait
            this.logger.error(e);
            await this.progress(Progress.ABORTED);
            await this.sleep(60);

            // Close existing attempt
            await this.page.close();
            await this.browser.close();

            // Retry
            await this.constructPage();
        }
    }

    /**
     * Construct page and add listeners
     */
    private async start() {
        // Build page and visit url
        await this.constructPage();

        // Add event listeners for requests and responses
        await this.page.setRequestInterception(true);
        this.page.on("request", (req) => this.interceptRequest(req));
        this.page.on("response", (res) => this.interceptResponse(res));
        this.page.on("requestfailed", (res) => this.interceptFailure(res));

        // Ignore dialog boxes
        this.page.on("dialog", (dialog) => dialog.dismiss());

        // Log errors
        this.page.on("error", (error) => this.logger.error(error));
    }

    /**
     * Close the page and browser
     */
    private async stop() {
        await this.progress(Progress.CLOSING);

        // Finish page promises
        await Promise.all(this.pagePromises);

        // Close page and browser
        await this.page.close();
        await this.browser.close();

        // Clear request buffers
        await this.requestBufferLock.acquireAsync();
        this.requestBuffer = [];
        this.requestBufferLock.release();

        // Clear response buffers
        await this.responseBufferLock.acquireAsync();
        this.responseBuffer = [];
        this.responseBufferLock.release();
    }

    /**
     * Pause and wait until resumed
     */
    private async waitResume() {
        // Pause for 200 milliseconds
        function f() {
            return new Promise(
                (resolve) => {
                    setTimeout(resolve, 200);
                },
            );
        }

        // Pause until pause toggled
        while (this.paused === true) {
            await this.progress(Progress.PAUSED);
            await f();
        }
    }

    /**
     * Pop a post of the postBuffer (using locks). Returns null if no posts in buffer
     */
    private async postPop() {
        let post = null;
        await this.postBufferLock.acquireAsync();
        if (this.postBuffer.length > 0) {
            post = this.postBuffer.shift();
        }
        this.postBufferLock.release();
        return post;
    }

    /**
     * Match the url to the url used in API requests
     */
    private matchURL(url: string) {
        return url.startsWith(this.catchURL) && !url.includes("include_reel");
    }

    /**
     * Print progress to stdout
     */
    private async progress(state: Progress) {
        // End if silent
        if (this.silent) {
            return;
        }

        // Lock
        await this.writeLock.acquireAsync();

        // Calculate total
        const total = this.total === 0 ? "Unlimited" : this.total;

        // Generate output string
        const idStr = chalk.bgYellow.black(` ${this.id} `);
        const totalStr = chalk.bgBlack(` Total: ${total} `);
        const stateStr = chalk.bgWhite.black(` State: ${state} `);
        const sleepStr = chalk.bgWhite.black(` Sleeping: ${this.sleepRemaining} `);
        const indexStr = chalk.bgWhite.black(` Scraped: ${this.index} `);

        const out = `${idStr}${totalStr}${stateStr}${sleepStr}${indexStr}`;

        this.logger.debug(out);

        // Print output
        process.stdout.write("\r" + out + "\u001B[K");

        // Release
        this.writeLock.release();
    }

    /**
     * Add request to the request buffer
     */
    private async interceptRequest(req: Request) {
        await this.requestBufferLock.acquireAsync();
        this.requestBuffer.push(req);
        await this.requestBufferLock.release();
    }

    /**
     * Add the response to the response buffer
     */
    private async interceptResponse(res: Response) {
        await this.responseBufferLock.acquireAsync();
        this.responseBuffer.push(res);
        await this.responseBufferLock.release();
    }

    /**
     * Log failed requests
     */
    private async interceptFailure(req: Request) {
        this.logger.info("Failed: " + req.url());
        await this.progress(Progress.ABORTED);
    }

    /**
     * Process the requests in the request buffer
     */
    private async processRequests() {
        await this.requestBufferLock.acquireAsync();

        for (const req of this.requestBuffer) {
            // Match url
            if (!this.matchURL(req.url())) {
                continue;
            }

            // Switch url and headers if grafting enabled, else store them
            let reqURL = req.url();
            let reqHeaders = req.headers();
            if (this.graft) {
                reqURL = this.lastURL;
                reqHeaders = this.lastHeaders;
            } else {
                this.lastURL = req.url();
                this.lastHeaders = req.headers();
            }

            // Get response
            await req.continue({
                headers: reqHeaders,
                url: reqURL,
            });
        }

        // Clear buffer and release
        this.requestBuffer = [];
        this.requestBufferLock.release();
    }

    /**
     * Process the responses in the response buffer
     */
    private async processResponses() {
        await this.responseBufferLock.acquireAsync();

        let disableGraft = false;
        for (const res of this.responseBuffer) {
            // Match url
            if (!this.matchURL(res.url())) {
                continue;
            } else {
                disableGraft = true;
            }

            // Get JSON data
            let data: JSON;
            try {
                data = await res.json();
            } catch (e) {
                this.logger.error("Error processing response JSON");
                this.logger.error(e);
            }

            // Check for rate limiting
            if (data && "status" in data && data["status"] === "fail") {
                this.logger.info("Rate limited");
                this.hibernate = true;
                continue;
            }

            // Check for next page
            if (!(_.get(data, this.pageQuery + ".has_next_page", false)
                && _.get(data, this.pageQuery + ".end_cursor", false))) {
                this.logger.info("No posts remaining");
                this.finished = true;
            }

            // Get posts
            const posts = _.get(data, this.edgeQuery, []);
            for (const post of posts) {
                const postId = post["node"]["id"];

                // Check it hasn't already been cached
                const contains = this.postIds.enqueue(postId);
                if (contains) {
                    this.logger.info("Duplicate id found: " + postId);
                    continue;
                }

                // Add to postBuffer
                if (this.index < this.total || this.total === 0) {
                    this.index++;
                    if (this.fullAPI) {
                        this.pagePromises.push(this.postPage(post["node"]["shortcode"]));
                    } else {
                        await this.addToPostBuffer(post);
                    }
                } else {
                    this.finished = true;
                    break;
                }
            }
        }

        // Switch off grafting if enabled and responses processed
        if (this.graft && disableGraft) {
            this.graft = false;
        }

        // Clear buffer and release
        this.responseBuffer = [];
        this.responseBufferLock.release();
    }

    /**
     * Add post to buffer
     */
    private async addToPostBuffer(post) {
        await this.postBufferLock.acquireAsync();
        this.postBuffer.push(post);
        this.postBufferLock.release();
    }

    /**
     * Open a post in a new page, then extract its metadata
     */
    private async postPage(post) {
        // Create page
        const postPage = await this.browser.newPage();
        await postPage.setRequestInterception(true);
        postPage.on("request", async (req) => {
            if (!req.url().includes("/p/" + post)) {
                await req.abort();
            } else {
                await req.continue();
            }
        });
        postPage.on("requestfailed", async () => undefined);

        // Visit post and read state
        let data;
        try {
            await postPage.goto("https://instagram.com/p/" + post);

            data = await postPage.evaluate(() => {
                return JSON.stringify(window["_sharedData"].entry_data.PostPage[0].graphql);
            });

            await this.addToPostBuffer(JSON.parse(data));

            await postPage.close();
        } catch (e) {
            // Log error and wait
            this.logger.error(e);
            await this.progress(Progress.ABORTED);
            await this.sleep(2);

            // Close existing attempt
            await postPage.close();

            // Retry
            await this.postPage(post);
        }
    }

    /**
     * Manipulate the page to stimulate a request
     */
    private async jump() {
        await this.page.keyboard.press("End");

        // Move mouse randomly
        const width = this.page.viewport()["width"];
        const height = this.page.viewport()["height"];
        await this.page.mouse.move(Math.round(width * Math.random()), Math.round(height * Math.random()));

        ++this.jumps;
    }

    /**
     * Halt execution
     * @param time Seconds
     */
    private async sleep(time) {
        for (let i = time; i > 0; i--) {
            this.sleepRemaining = i;
            await this.progress(Progress.SCRAPING);
            await new Promise(
                (resolve) => {
                    setTimeout(resolve, 1000);
                });
        }
        this.sleepRemaining = 0;
        await this.progress(Progress.SCRAPING);
    }

    /**
     * Clear request and response buffers
     */
    private async initiateGraft() {
        // Check if enabled
        if (!this.enableGrafting) {
            return;
        }

        await this.progress(Progress.GRAFTING);

        // Close browser and page
        await this.stop();

        // Enable grafting
        this.graft = true;

        // Re-start page
        await this.start();
    }

    /**
     * Stimulate the page until responses gathered
     */
    private async getNext() {
        await this.progress(Progress.SCRAPING);
        while (true) {
            // Process results (if any)
            await this.processRequests();
            await this.processResponses();

            // Check if finished
            if (this.finished) {
                break;
            }

            // Pause if paused
            await this.waitResume();

            // Interact with page to stimulate request
            await this.jump();

            // Enable grafting if required
            if (this.jumps % this.jumpMod === 0) {
                await this.initiateGraft();
            }

            // Sleep
            await this.sleep(this.sleepTime);

            // Finish page promises
            await this.progress(Progress.BRANCHING);
            await Promise.all(this.pagePromises);
            this.pagePromises = [];

            // Hibernate if rate-limited
            if (this.hibernate) {
                await this.sleep(this.hibernationTime);
                this.hibernate = false;
            }

            // Break if posts in buffer
            await this.postBufferLock.acquireAsync();
            const posts = this.postBuffer.length;
            this.postBufferLock.release();
            if (posts > 0) {
                break;
            }
        }
    }
}

/**
 * An Instagram hashtag API wrapper
 */
export class Hashtag extends Instagram {
    constructor(id: string, options: object = {}) {
        const endpoint = "https://instagram.com/explore/tags/";
        const pageQuery = "data.hashtag.edge_hashtag_to_media.page_info";
        const edgeQuery = "data.hashtag.edge_hashtag_to_media.edges";
        super(endpoint, id, pageQuery, edgeQuery, options);
    }
}

/**
 * An Instagram location API wrapper
 */
export class Location extends Instagram {
    constructor(id: string, options: object = {}) {
        const endpoint = "https://instagram.com/explore/locations/";
        const pageQuery = "data.location.edge_location_to_media.page_info";
        const edgeQuery = "data.location.edge_location_to_media.edges";
        super(endpoint, id, pageQuery, edgeQuery, options);
    }
}

/**
 * An Instagram user API wrapper
 */
export class User extends Instagram {
    constructor(id: string, options: object = {}) {
        const endpoint = "https://instagram.com/";
        const pageQuery = "data.user.edge_owner_to_timeline_media.page_info";
        const edgeQuery = "data.user.edge_owner_to_timeline_media.edges";
        super(endpoint, id, pageQuery, edgeQuery, options);
    }
}
