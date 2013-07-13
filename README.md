v8-debugger
====================

An attempt to export v8 debugger protocol client as a reusable module. Current source code extracted from built-in node debugger (see [\_debugger.js](https://github.com/joyent/node/blob/master/lib/_debugger.js) original source)

API
===

```js
var client = require('v8-debugger').createClient({port: 5858});
clident.reqBacktrace(function(err, res) {
   // backtrace data
});

```
