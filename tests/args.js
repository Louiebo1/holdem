// Hands the command line to modules: jsc tests/args.js -m tests/bench.js -- 100 3
globalThis.scriptArgs = typeof arguments !== "undefined" ? [...arguments] : [];
