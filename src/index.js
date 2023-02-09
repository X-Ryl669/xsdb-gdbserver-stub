/**
 * Copyright (c) Tatsuo Nomura <tatsuo.nomura@gmail.com>
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { XSDB } from "./xsdb.js";
import { GDBServerStub } from "./gdb-server-stub.js";

function runServer(args) {
  const xsdb = new XSDB(args.slice(1));
  const server = new GDBServerStub(xsdb);
  server.start("localhost", args[0] ? args[0] : 2424);
  function runCpu() {
    xsdb.run(100);
  }
  setInterval(runCpu, 100);
}

process.on("unhandledRejection", (error) => {
  console.log("Unhandler Rejection");
  console.error(error); // This prints error with stack included (as for normal errors)
  throw error; // Following best practices re-throw error and let the process exit with error code
});

if (process.env.NODE_ENV != 'test') {
  let args = process.argv.slice(2);
  if (args[0] == '--help' || args[0] == '-h' || args.len <= 2) {
    console.log("Usage: " + process.argv[0] + " " + process.argv[1] + " listening_port xsdb_args");
  } else runServer(args);
}
