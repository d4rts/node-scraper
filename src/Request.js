class Request {
    constructor(url) {
        this.type = "GET"; /* GET/POST/PUT/DELETE[...] */
        this.url = url;
        this.reinjectCookies = true;
        this.headers = {};
        this.postData = null;
        this.jsonData = null;
        this.timeout = null; //ms
        this.proxy = {
            use: false,
            host: "localhost",
            port: 9050,
            username: "",
            password: ""
        };
    }
}

module.exports = Request;