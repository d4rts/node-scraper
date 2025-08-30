exports.print = function(str) {
  console.log(getPrefix(new Date()) + ": " + str);

};

exports.printerr = function(str) {
  console.error(getPrefix(new Date()) + ": \x1b[31m" + str + "\x1b[0m");
};

function getPrefix(date) {
  var Prefix = "[Scraper] " + date.getDay() + "/" + date.getMonth() + "/" +
                (date.getYear() - 100) + " " + date.getHours() + ":" +
                date.getMinutes() + ":" + date.getSeconds();
  return (Prefix);
}
