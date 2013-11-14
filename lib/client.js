// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

var util = require('util'),
    net = require('net'),
    inherits = util.inherits,
    Protocol = require('./protocol');

var NO_FRAME=1;

module.exports = Client;

function Client() {
  net.Stream.call(this);
  debugger;
  var protocol = this.protocol = new Protocol(this);
  this._reqCallbacks = [];
  var socket = this;

  this.currentFrame = NO_FRAME;
  this.currentSourceLine = -1;
  this.currentSource = null;
  this.handles = {};
  this.scripts = {};
  this.scriptIdFromName = {};
  this.breakpoints = [];

  // Note that 'Protocol' requires strings instead of Buffers.
  socket.setEncoding('utf8');
  socket.on('data', function(d) {
    protocol.execute(d);
  });

  protocol.onResponse = this._onResponse.bind(this);
}
inherits(Client, net.Stream);


Client.prototype._addHandle = function(desc) {
  if (typeof desc != 'object' || typeof desc.handle != 'number') {
    return;
  }

  this.handles[desc.handle] = desc;

  if (desc.type == 'script') {
    this._addScript(desc);
  }
};


var natives = process.binding('natives');


Client.prototype._addScript = function(desc) {
  this.scripts[desc.id] = desc;
  if (desc.name) {
    desc.isNative = (desc.name.replace('.js', '') in natives) ||
                    desc.name == 'node.js';
    this.scriptIdFromName[desc.name] = desc.id;
  }
};


Client.prototype._removeScript = function(desc) {
  this.scripts[desc.id] = undefined;
};


Client.prototype._onResponse = function(res) {
  var cb,
      index = -1;

  this._reqCallbacks.some(function(fn, i) {
    if (fn.request_seq == res.body.request_seq) {
      cb = fn;
      index = i;
      return true;
    }
  });

  var self = this;
  var handled = false;

  if (res.headers.Type == 'connect') {
    // Request a list of scripts for our own storage.
    self.reqScripts(function() {
      self.emit('ready', res);
    });
    handled = true;

  } else if (res.body && res.body.event == 'break') {
    this.emit('break', res.body);
    handled = true;

  } else if (res.body && res.body.event == 'exception') {
    this.emit('exception', res.body);
    handled = true;

  } else if (res.body && res.body.event == 'afterCompile') {
    this._addHandle(res.body.body.script);
    handled = true;

  } else if (res.body && res.body.event == 'scriptCollected') {
    // ???
    this._removeScript(res.body.body.script);
    handled = true;

  }

  if (cb) {
    this._reqCallbacks.splice(index, 1);
    handled = true;

    var err = res.success === false && (res.message || true) ||
              res.body.success === false && (res.body.message || true);
    cb(err, res.body && res.body.body || res.body, res);
  }

  if (!handled) this.emit('unhandledResponse', res.body);
};


Client.prototype.req = function(req, cb) {
  this.write(this.protocol.serialize(req));
  cb.request_seq = req.seq;
  this._reqCallbacks.push(cb);
};


Client.prototype.reqVersion = function(cb) {
  cb = cb || function() {};
  this.req({ command: 'version' } , function(err, body, res) {
    if (err) return cb(err);
    cb(null, res.body.body.V8Version, res.body.running);
  });
};


Client.prototype.reqLookup = function(refs, cb) {
  var self = this;

  // TODO: We have a cache of handle's we've already seen in this.handles
  // This can be used if we're careful.
  var req = {
    command: 'lookup',
    'arguments': {
      handles: refs,
      includeSource: true
    }
  };

  cb = cb || function() {};
  this.req(req, function(err, res) {
    if (err) return cb(err);
    for (var ref in res) {
      if (typeof res[ref] == 'object') {
        self._addHandle(res[ref]);
      }
    }

    cb(null, res);
  });
};

Client.prototype.reqScopes = function(cb) {
  var self = this,
      req = {
        command: 'scopes',
        'arguments': {}
      };

  cb = cb || function() {};
  this.req(req, function(err, res) {
    if (err) return cb(err);
    var refs = res.scopes.map(function(scope) {
      return scope.object.ref;
    });

    self.reqLookup(refs, function(err, res) {
      if (err) return cb(err);

      var globals = Object.keys(res).map(function(key) {
        return res[key].properties.map(function(prop) {
          return prop.name;
        });
      });

      cb(null, globals.reverse());
    });
  });
};

// This is like reqEval, except it will look up the expression in each of the
// scopes associated with the current frame.
Client.prototype.reqEval = function(expression, cb) {
  var self = this;

  if (this.currentFrame == NO_FRAME) {
    // Only need to eval in global scope.
    this.reqFrameEval(expression, NO_FRAME, cb);
    return;
  }

  cb = cb || function() {};
  // Otherwise we need to get the current frame to see which scopes it has.
  this.reqBacktrace(function(err, bt) {
    if (err || !bt.frames) {
      // ??
      return cb(null, {});
    }

    var frame = bt.frames[self.currentFrame];

    var evalFrames = frame.scopes.map(function(s) {
      if (!s) return;
      var x = bt.frames[s.index];
      if (!x) return;
      return x.index;
    });

    self._reqFramesEval(expression, evalFrames, cb);
  });
};


// Finds the first scope in the array in which the epxression evals.
Client.prototype._reqFramesEval = function(expression, evalFrames, cb) {
  if (evalFrames.length === 0) {
    // Just eval in global scope.
    this.reqFrameEval(expression, NO_FRAME, cb);
    return;
  }

  var self = this;
  var i = evalFrames.shift();

  cb = cb || function() {};
  this.reqFrameEval(expression, i, function(err, res) {
    if (!err) return cb(null, res);
    self._reqFramesEval(expression, evalFrames, cb);
  });
};


Client.prototype.reqFrameEval = function(expression, frame, cb) {
  var self = this;
  var req = {
    command: 'evaluate',
    'arguments': { expression: expression }
  };

  if (frame == NO_FRAME) {
    req.arguments.global = true;
  } else {
    req.arguments.frame = frame;
  }

  cb = cb || function() {};
  this.req(req, function(err, res) {
    if (!err) self._addHandle(res);
    cb(err, res);
  });
};


// reqBacktrace(cb)
// TODO: from, to, bottom
Client.prototype.reqBacktrace = function(cb) {
  this.req({ command: 'backtrace', 'arguments': { inlineRefs: true } } , cb);
};


// reqSetExceptionBreak(type, cb)
// TODO: from, to, bottom
Client.prototype.reqSetExceptionBreak = function(type, cb) {
  this.req({
    command: 'setexceptionbreak',
    'arguments': { type: type, enabled: true }
  }, cb);
};


// Returns an array of objects like this:
//
//   { handle: 11,
//     type: 'script',
//     name: 'node.js',
//     id: 14,
//     lineOffset: 0,
//     columnOffset: 0,
//     lineCount: 562,
//     sourceStart: '(function(process) {\n\n  ',
//     sourceLength: 15939,
//     scriptType: 2,
//     compilationType: 0,
//     context: { ref: 10 },
//     text: 'node.js (lines: 562)' }
//
Client.prototype.reqScripts = function(cb) {
  var self = this;
  cb = cb || function() {};

  this.req({ command: 'scripts', arguments: {'includeSource': true} } , function(err, res) {
    if (err) return cb(err);

    for (var i = 0; i < res.length; i++) {
      self._addHandle(res[i]);
    }
    cb(null);
  });
};


Client.prototype.reqContinue = function(cb) {
  this.currentFrame = NO_FRAME;
  this.req({ command: 'continue' }, cb);
};

Client.prototype.listbreakpoints = function(cb) {
  this.req({ command: 'listbreakpoints' }, cb);
};

Client.prototype.setBreakpoint = function(req, cb) {
  req = {
    command: 'setbreakpoint',
    arguments: req
  };

  this.req(req, cb);
};

Client.prototype.clearBreakpoint = function(req, cb) {
  var req = {
    command: 'clearbreakpoint',
    arguments: req
  };

  this.req(req, cb);
};

Client.prototype.reqSource = function(from, to, cb) {
  var req = {
    command: 'source',
    fromLine: from,
    toLine: to
  };

  this.req(req, cb);
};


// client.next(1, cb);
Client.prototype.step = function(action, count, cb) {
  var req = {
    command: 'continue',
    arguments: { stepaction: action, stepcount: count }
  };

  this.currentFrame = NO_FRAME;
  this.req(req, cb);
};


Client.prototype.mirrorObject = function(handle, depth, cb) {
  var self = this;

  var val;

  if (handle.type === 'object') {
    // The handle looks something like this:
    // { handle: 8,
    //   type: 'object',
    //   className: 'Object',
    //   constructorFunction: { ref: 9 },
    //   protoObject: { ref: 4 },
    //   prototypeObject: { ref: 2 },
    //   properties: [ { name: 'hello', propertyType: 1, ref: 10 } ],
    //   text: '#<an Object>' }

    // For now ignore the className and constructor and prototype.
    // TJ's method of object inspection would probably be good for this:
    // https://groups.google.com/forum/?pli=1#!topic/nodejs-dev/4gkWBOimiOg

    var propertyRefs = handle.properties.map(function(p) {
      return p.ref;
    });

    cb = cb || function() {};
    this.reqLookup(propertyRefs, function(err, res) {
      if (err) {
        console.error('problem with reqLookup');
        cb(null, handle);
        return;
      }

      var mirror,
          waiting = 1;

      if (handle.className == 'Array') {
        mirror = [];
      } else if (handle.className == 'Date') {
        mirror = new Date(handle.value);
      } else {
        mirror = {};
      }


      var keyValues = [];
      handle.properties.forEach(function(prop, i) {
        var value = res[prop.ref];
        var mirrorValue;
        if (value) {
          mirrorValue = value.value ? value.value : value.text;
        } else {
          mirrorValue = '[?]';
        }


        if (Array.isArray(mirror) &&
            typeof prop.name != 'number') {
          // Skip the 'length' property.
          return;
        }

        keyValues[i] = {
          name: prop.name,
          value: mirrorValue
        };
        if (value && value.handle && depth > 0) {
          waiting++;
          self.mirrorObject(value, depth - 1, function(err, result) {
            if (!err) keyValues[i].value = result;
            waitForOthers();
          });
        }
      });

      waitForOthers();
      function waitForOthers() {
        if (--waiting === 0 && cb) {
          keyValues.forEach(function(kv) {
            mirror[kv.name] = kv.value;
          });
          cb(null, mirror);
        }
      };
    });
    return;
  } else if (handle.type === 'function') {
    val = function() {};
  } else if (handle.type === 'null') {
    val = null;
  } else if (handle.value !== undefined) {
    val = handle.value;
  } else if (handle.type === 'undefined') {
    val = undefined;
  } else {
    val = handle;
  }
  process.nextTick(function() {
    cb(null, val);
  });
};


Client.prototype.fullTrace = function(cb) {
  var self = this;

  cb = cb || function() {};
  this.reqBacktrace(function(err, trace) {
    if (err) return cb(err);
    if (trace.totalFrames <= 0) return cb(Error('No frames'));

    var refs = [];

    for (var i = 0; i < trace.frames.length; i++) {
      var frame = trace.frames[i];
      // looks like this:
      // { type: 'frame',
      //   index: 0,
      //   receiver: { ref: 1 },
      //   func: { ref: 0 },
      //   script: { ref: 7 },
      //   constructCall: false,
      //   atReturn: false,
      //   debuggerFrame: false,
      //   arguments: [],
      //   locals: [],
      //   position: 160,
      //   line: 7,
      //   column: 2,
      //   sourceLineText: '  debugger;',
      //   scopes: [ { type: 1, index: 0 }, { type: 0, index: 1 } ],
      //   text: '#00 blah() /home/ryan/projects/node/test-debug.js l...' }
      refs.push(frame.script.ref);
      refs.push(frame.func.ref);
      refs.push(frame.receiver.ref);
    }

    self.reqLookup(refs, function(err, res) {
      if (err) return cb(err);

      for (var i = 0; i < trace.frames.length; i++) {
        var frame = trace.frames[i];
        frame.script = res[frame.script.ref];
        frame.func = res[frame.func.ref];
        frame.receiver = res[frame.receiver.ref];
      }

      cb(null, trace);
    });
  });
};

var commands = [
  [
    'run (r)',
    'cont (c)',
    'next (n)',
    'step (s)',
    'out (o)',
    'backtrace (bt)',
    'setBreakpoint (sb)',
    'clearBreakpoint (cb)'
  ],
  [
    'watch',
    'unwatch',
    'watchers',
    'repl',
    'restart',
    'kill',
    'list',
    'scripts',
    'breakOnException',
    'breakpoints',
    'version'
  ]
];


var helpMessage = 'Commands: ' + commands.map(function(group) {
  return group.join(', ');
}).join(',\n');


function SourceUnderline(sourceText, position, repl) {
  if (!sourceText) return '';

  var head = sourceText.slice(0, position),
      tail = sourceText.slice(position);

  // Colourize char if stdout supports colours
  if (repl.useColors) {
    tail = tail.replace(/(.+?)([^\w]|$)/, '\u001b[32m$1\u001b[39m$2');
  }

  // Return source line with coloured char at `position`
  return [
    head,
    tail
  ].join('');
}


function SourceInfo(body) {
  var result = body.exception ? 'exception in ' : 'break in ';

  if (body.script) {
    if (body.script.name) {
      var name = body.script.name,
          dir = path.resolve() + '/';

      // Change path to relative, if possible
      if (name.indexOf(dir) === 0) {
        name = name.slice(dir.length);
      }

      result += name;
    } else {
      result += '[unnamed]';
    }
  }
  result += ':';
  result += body.sourceLine + 1;

  if (body.exception) result += '\n' + body.exception.text;

  return result;
}
