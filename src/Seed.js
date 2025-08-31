const Utils = require('./Utils');

class Seed {
  constructor(logStandartTty = true, logErrorsTty = true) {
    /** @type {import('src/SeedElement')[]} */
    this.seed = [];
    this.logStandartTty = logStandartTty;
    this.logErrorsTty = logErrorsTty;
  }


  /**
   * @param {import('src/SeedElement')} seedElement
   */
  push(seedElement) {
    let added = false;
    for (let i = 0; i < this.seed.length; i++) {
      if (this.seed[i].request.url === seedElement.request.url) {
        added = true;
        break;
      }
    }

    if (! added || seedElement.forceSeed) {
      this.seed.push(seedElement);
      Utils.print("Add to seed : " + seedElement.request.url, this.logStandartTty);
    }
  }

  getWaitingForTreatment() {
    for (let i = 0; i < this.seed.length; i++) {
      if (this.seed[i].state === 'WAITING') {
        this.seed[i].state = 'TREATING';
        return this.seed[i];
      }
    }
    return null;
  }

  treatingElementToWaiting(seedElement) {
    seedElement.state = 'WAITING';
  }

  treatingElementToEnded(seedElement) {
    seedElement.state = 'ENDED';
  }

  waitingLength() {
    let count = 0;
    for (let i = 0; i < this.seed.length; i++) {
        if (this.seed[i].state === 'WAITING') {
          count++;
        }
    }
    return count;
  }

  treatingLength() {
    let count = 0;
    for (let i = 0; i < this.seed.length; i++) {
      if (this.seed[i].state === 'TREATING') {
        count++;
      }
    }
    return count;
  }
}

module.exports = Seed;