var Client = require('./lib/client.js');
module.exports.Client = Client;
module.exports.createClient = function(params) {
  var c = new Client();
  c.connect(params.port);
  return c;
};
