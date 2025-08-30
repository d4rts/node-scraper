const request = require('./Request');

class SeedElement {
    /**
     * @param {import('./Request')} request
     */
    constructor(request) {
        this.request = request;
        this.forceSeed = false;
        this.callback = null;
        this.state = "WAITING";
        this.customParams = {};
    }
}

module.exports = SeedElement;