#!/usr/bin/env node
/** The `topped` binary: one run, one JSON document on stdout, one exit code. */

import { realDeps } from "./deps.js";
import { run } from "./main.js";

const code = await run(process.argv.slice(2), realDeps());
process.exitCode = code;
