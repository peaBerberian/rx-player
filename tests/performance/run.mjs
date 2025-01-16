#!/usr/bin/env node
/* eslint-env node */

import { exec, spawn } from "child_process";
import esbuild from "esbuild";
import * as fs from "fs/promises";
import { createServer } from "http";
import * as path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import launchStaticServer from "../../scripts/launch_static_server.mjs";
import removeDir from "../../scripts/utils/remove_dir.mjs";
import createContentServer from "../contents/server.mjs";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));

/** Port of the HTTP server which will serve local contents. */
const CONTENT_SERVER_PORT = 3000;

/** Port of the HTTP server which will serve the performance test files */
const PERF_TESTS_PORT = 8080;

/**
 * Number of times test are runs on each browser/RxPlayer configuration.
 * More iterations means (much) more time to perform tests, but also produce
 * better estimates.
 *
 * TODO: GitHub actions fails when running the 128th browser. Find out why.
 */
const TEST_ITERATIONS = 100;

/**
 * After initialization is done, contains the path allowing to run the Chrome
 * browser.
 * @type {string|undefined|null}
 */
let CHROME_CMD;

// /**
//  * After initialization is done, contains the path allowing to run the Firefox
//  * browser.
//  * @type {string|undefined|null}
//  */
// let FIREFOX_CMD;

/** Options used when starting the Chrome browser. */
const CHROME_OPTIONS = [
  "--enable-automation",
  "--no-default-browser-check",
  "--no-first-run",
  "--disable-default-apps",
  "--disable-popup-blocking",
  "--disable-translate",
  "--disable-background-timer-throttling",
  "--disable-renderer-backgrounding",
  "--disable-device-discovery-notifications",
  "--autoplay-policy=no-user-gesture-required",
  "--headless",
  "--disable-gpu",
  "--disable-dev-shm-usage",
  "--disk-cache-dir=/dev/null",
];

// /** Options used when starting the Firefox browser. */
// const FIREFOX_OPTIONS = [
//   "-no-remote",
//   "-wait-for-browser",
//   "-headless",
// ];

/**
 * `ChildProcess` instance of the current browser being run.
 * `undefined` if no browser is currently being run.
 */
let currentBrowser;

/**
 * Contains "tasks" which are function each run inside a new browser process.
 * Task are added by groups of two:
 *   - the first one testing the current player build
 *   - the second one testing the last RxPlayer production version.
 */
const tasks = [];

/**
 * Index of the currently ran task in the `tasks` array.
 * @see tasks
 */
let nextTaskIndex = 0;

/**
 * Store results of the performance tests in two arrays:
 *   - "current" contains the test results of the current RxPlayer version
 *   - "previous" contains the test results of the last RxPlayer version
 */
const allSamples = {
  current: [],
  previous: [],
};

/**
 * Contains references to every launched servers, with a `close` method allowing
 * to close each one of them.
 */
const servers = [];

// If true, this script is called directly
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.includes("-h") || args.includes("--help")) {
    displayHelp();
    process.exit(0);
  }

  let branchName;
  {
    let branchNameIndex = args.indexOf("-b");
    if (branchNameIndex < 0) {
      branchNameIndex = args.indexOf("--branch");
    }
    if (branchNameIndex >= 0) {
      branchName = args[branchNameIndex + 1];
      if (branchName === undefined) {
        // eslint-disable-next-line no-console
        console.error("ERROR: no branch name provided\n");
        displayHelp();
        process.exit(1);
      }
    }
  }

  let remote;
  {
    let branchNameIndex = args.indexOf("-u");
    if (branchNameIndex < 0) {
      branchNameIndex = args.indexOf("--remote-git-url");
    }
    if (branchNameIndex >= 0) {
      remote = args[branchNameIndex + 1];
      if (remote === undefined) {
        // eslint-disable-next-line no-console
        console.error("ERROR: no remote URL provided\n");
        displayHelp();
        process.exit(1);
      }
    }
  }

  startPerformanceTests({ branchName, remote })
    .then((results) => {
      if (results.failures.length > 0) {
        // eslint-disable-next-line no-console
        console.warn("Tests failed for", results.failures.join(", "));
        // eslint-disable-next-line no-console
        console.warn("Retrying one time just to check if unlucky...");
        return startPerformanceTests({ branchName, remote }).then((results2) => {
          // eslint-disable-next-line no-console
          console.error(
            "Tests failed at first attempt for:",
            results.failures.join(", "),
          );
          if (results2.failures.length > 0) {
            for (const failure1 of results.failures) {
              if (results2.failures.includes(failure1)) {
                // eslint-disable-next-line no-console
                console.error(
                  "Tests failed at second attempt for:",
                  results2.failures.join(", "),
                );
                process.exit(1);
              }
              // eslint-disable-next-line no-console
              console.error(
                "Tests failed at second attempt for:",
                results2.failures.join(", "),
              );
            }
          }
        });
      }
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error("Error:", err);
      return process.exit(1);
    });
}

/**
 * Initialize and start all tests on Chrome.
 * @param {Object} opts - Various options to configure performance tests.
 * @param {string} [opts.branchName] - The name of the branch results should be
 * compared to.
 * `dev` by default.
 * @param {string} [opts.remoteGitUrl] - The git URL where the current
 * repository can be cloned for comparisons.
 * The one for the current git repository by default.
 * @returns {Promise.<Object>}
 */
function startPerformanceTests({ branchName, remoteGitUrl } = {}) {
  return new Promise((resolve, reject) => {
    const onFinished = () => {
      const results = compareSamples();
      shutdown().catch((err) => {
        // eslint-disable-next-line no-console
        console.error("Failed to shutdown:", err);
      });
      resolve(results);
    };
    const onError = (error) => {
      shutdown().catch((err) => {
        // eslint-disable-next-line no-console
        console.error("Failed to shutdown:", err);
      });
      reject(error);
    };
    initScripts({
      branchName: branchName ?? "dev",
      remoteGitUrl,
    })
      .then(() => initServers(onFinished, onError))
      .then(startAllTestsOnChrome)
      .catch(onError);
  });
}

/**
 * Initialize all servers used for the performance tests.
 * @param {Function} onFinished
 * @param {function} onError
 * @returns {Promise} - Resolves when all servers are listening.
 */
async function initServers(onFinished, onError) {
  const contentServer = createContentServer(CONTENT_SERVER_PORT);
  const staticServer = launchStaticServer(currentDirectory, {
    httpPort: PERF_TESTS_PORT,
  });
  const resultServer = createResultServer(onFinished, onError);
  servers.push(contentServer, staticServer, resultServer);
  await Promise.all([
    contentServer.listeningPromise,
    staticServer.listeningPromise,
    resultServer.listeningPromise,
  ]);
}

/**
 * Prepare all scripts needed for the performance tests.
 * @param {Object} opts - Various options for scripts initialization.
 * @param {string} opts.branchName - The name of the branch results should be
 * compared to.
 * @param {string} [opts.remoteGitUrl] - The git URL where the current
 * repository can be cloned for comparisons.
 * The one for the current git repository by default.
 * @returns {Promise} - Resolves when the initialization is finished.
 */
async function initScripts({ branchName, remoteGitUrl }) {
  await prepareLastRxPlayerTests({ branchName, remoteGitUrl });
  await prepareCurrentRxPlayerTests();
}

/**
 * Build test file for testing the current RxPlayer.
 * @returns {Promise}
 */
async function prepareCurrentRxPlayerTests() {
  await linkCurrentRxPlayer();
  await createBundle({ output: "current.js", minify: false, production: true });
}

/**
 * Build test file for testing the last version of the RxPlayer.
 * @param {Object} opts - Various options.
 * @param {string} opts.branchName - The name of the branch results should be
 * compared to.
 * @param {string} [opts.remoteGitUrl] - The git URL where the current
 * repository can be cloned for comparisons.
 * The one for the current git repository by default.
 * @returns {Promise}
 */
async function prepareLastRxPlayerTests({ branchName, remoteGitUrl }) {
  await linkRxPlayerBranch({ branchName, remoteGitUrl });
  await createBundle({ output: "previous.js", minify: false, production: true });
}

/**
 * Link the current RxPlayer to the performance tests, so its performance can be
 * tested.
 * @returns {Promise}
 */
async function linkCurrentRxPlayer() {
  const rootDir = path.join(currentDirectory, "..", "..");
  await removeDir(path.join(rootDir, "dist"));

  const innerNodeModulesPath = path.join(currentDirectory, "node_modules");
  await removeDir(innerNodeModulesPath);
  await fs.mkdir(innerNodeModulesPath);
  const rxPlayerPath = path.join(innerNodeModulesPath, "rx-player");
  await spawnProc(
    "npm run build",
    [],
    (code) => new Error(`npm run build exited with code ${code}`),
  ).promise;
  await fs.symlink(path.join(currentDirectory, "..", ".."), rxPlayerPath);
}

/**
 * Link the last published RxPlayer version to the performance tests, so
 * performance of new code can be compared to it.
 * @param {Object} opts - Various options.
 * @param {string} opts.branchName - The name of the branch results should be
 * compared to.
 * @param {string} [opts.remoteGitUrl] - The git URL where the current
 * repository can be cloned for comparisons.
 * The one for the current git repository by default.
 * @returns {Promise}
 */
async function linkRxPlayerBranch({ branchName, remoteGitUrl }) {
  const rootDir = path.join(currentDirectory, "..", "..");
  await removeDir(path.join(rootDir, "dist"));

  const innerNodeModulesPath = path.join(currentDirectory, "node_modules");
  await removeDir(innerNodeModulesPath);
  await fs.mkdir(innerNodeModulesPath);
  const rxPlayerPath = path.join(innerNodeModulesPath, "rx-player");
  let url =
    remoteGitUrl ??
    (await execCommandAndGetFirstOutput("git config --get remote.origin.url"));
  url = url.trim();
  await spawnProc(
    `git clone -b ${branchName} ${url} ${rxPlayerPath}`,
    [],
    (code) => new Error(`git clone exited with code ${code}`),
  ).promise;
  await spawnProc(
    `cd ${rxPlayerPath} && npm install`,
    [],
    (code) => new Error(`npm install failed with code ${code}`),
  ).promise;
  await spawnProc(
    `cd ${rxPlayerPath} && npm run build`,
    [],
    (code) => new Error(`npm run build exited with code ${code}`),
  ).promise;
  await spawnProc(
    `cd ${rxPlayerPath} && cat VERSION`,

    [],
    (code) => new Error(`npm run build exited with code ${code}`),
  ).promise;

  // GitHub actions, for unknown reasons, want to use the root's `dist` directory
  // TODO: find why
  await fs.symlink(
    path.join(rxPlayerPath, "dist"),
    path.join(currentDirectory, "..", "..", "dist"),
  );
}

/**
 * Build the `tasks` array and start all tests on the Chrome browser.
 * @returns {Promise}
 */
async function startAllTestsOnChrome() {
  CHROME_CMD = await getChromeCmd();
  for (let i = 0; i < TEST_ITERATIONS; i++) {
    tasks.push(() => startTestsOnChrome(i % 2 === 0, i + 1, TEST_ITERATIONS));
  }
  if (CHROME_CMD === null) {
    throw new Error("Error: Chrome not found on the current platform");
  }
  if (tasks.length === 0) {
    throw new Error("No task scheduled");
  }
  nextTaskIndex++;
  return tasks[nextTaskIndex - 1]();
}

/**
 * Free all resources and terminate script.
 */
async function shutdown() {
  if (currentBrowser !== undefined) {
    currentBrowser.kill("SIGKILL");
    currentBrowser = undefined;
  }
  while (servers.length > 0) {
    servers.pop().close();
  }
}

/**
 * Starts the next function in the `tasks` array.
 * If no task are available anymore, call the `onFinished` callback.
 * @param {Function} onFinished
 */
function startNextTaskOrFinish(onFinished) {
  if (tasks[nextTaskIndex] === undefined) {
    onFinished();
  }
  nextTaskIndex++;
  return tasks[nextTaskIndex - 1]();
}

/**
 * Start Chrome browser running performance tests.
 * @param {boolean} startWithCurrent - If `true` we will begin with tests on the
 * current build. If `false` we will start with the previous build. We will
 * then alternate.
 * The global idea is to ensure we're testing both cases as to remove some
 * potential for lower performances due e.g. to browser internal logic.
 * @param {number} testNb - The current test iteration, starting from `1` to
 * `testTotal`. Used to indicate progress.
 * @param {number} testTotal - The maximum number of iterations. Used to
 * indicate progress.
 * @returns {Promise}
 */
async function startTestsOnChrome(startWithCurrent, testNb, testTotal) {
  // eslint-disable-next-line no-console
  console.log(`Running tests on Chrome (${testNb}/${testTotal})`);
  return startPerfhomepageOnChrome(
    startWithCurrent ? "current.html" : "previous.html",
  ).catch((err) => {
    throw new Error("Could not launch page on Chrome: " + err.toString());
  });
}

/**
 * Start the performance tests on Chrome.
 * Set `currentBrowser` to chrome.
 * @param {string} homePage - Page on which to run the browser.
 */
async function startPerfhomepageOnChrome(homePage) {
  if (currentBrowser !== undefined) {
    currentBrowser.kill("SIGKILL");
  }
  if (CHROME_CMD === undefined || CHROME_CMD === null) {
    throw new Error("Starting browser before initialization");
  }
  const spawned = spawnProc(CHROME_CMD, [
    ...CHROME_OPTIONS,
    `http://localhost:${PERF_TESTS_PORT}/${homePage}`,
  ]);
  currentBrowser = spawned.child;
}

/**
 * Create HTTP server which will receive test results and react appropriately.
 * @param {Function} onFinished
 * @param {function} onError
 * @returns {Object}
 */
function createResultServer(onFinished, onError) {
  const server = createServer(onRequest);
  return {
    listeningPromise: new Promise((res) => {
      server.listen(6789, function () {
        res();
      });
    }),
    close() {
      server.close();
    },
  };

  function onRequest(request, response) {
    if (request.method === "OPTIONS") {
      answerWithCORS(response, 200);
      response.end();
    } else if (request.method == "POST") {
      let body = "";
      request.on("data", function (data) {
        body += data;
      });
      request.on("end", function () {
        try {
          const parsedBody = JSON.parse(body);
          if (parsedBody.type === "log") {
            // eslint-disable-next-line no-console
            console.warn("LOG:", parsedBody.data);
          } else if (parsedBody.type === "error") {
            onError(new Error("ERROR: A fatal error happened: " + parsedBody.data));
            return;
          } else if (parsedBody.type === "done") {
            if (currentBrowser !== undefined) {
              currentBrowser.kill("SIGKILL");
              currentBrowser = undefined;
            }
            if (allSamples.previous.length > 0 && allSamples.current.length > 0) {
              compareSamples();
            }
            startNextTaskOrFinish(onFinished).catch(onError);
          } else if (parsedBody.type === "value") {
            let page;
            if (parsedBody.page === "current") {
              page = "current";
            } else if (parsedBody.page === "previous") {
              page = "previous";
            } else {
              onError(new Error("Unknown page: " + parsedBody.page));
              return;
            }
            allSamples[page].push(parsedBody.data);
          }
          answerWithCORS(response, 200, "OK");
          return;
        } catch (err) {
          answerWithCORS(response, 500, "Invalid data format.");
          return;
        }
      });
    }
  }

  /**
   * Add CORS headers, Content-Length, body, HTTP status and answer with the
   * Response Object given.
   * @param {Response} response
   * @param {number} status
   * @param {*} body
   */
  function answerWithCORS(response, status, body) {
    if (Buffer.isBuffer(body)) {
      response.setHeader("Content-Length", body.byteLength);
    }
    response.writeHead(status, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Allow-Credentials": true,
      "Access-Control-Allow-Methods": "GET, OPTIONS",
    });
    if (body !== undefined) {
      response.end(body);
    } else {
      response.end();
    }
  }
}

/**
 * Construct array from the given list which contains both the value and a added
 * `rank` property useful for the Mann–Whitney U test.
 * @param {Array.<number>} list
 * @returns {Array.<Object>}
 */
function rankSamples(list) {
  list.sort((a, b) => a - b);
  const withRank = list.map(function (item, index) {
    return {
      rank: index + 1,
      value: item,
    };
  });

  for (let i = 0; i < withRank.length; ) {
    let count = 1;
    let total = withRank[i].rank;

    for (
      let j = 0;
      withRank[i + j + 1] !== undefined &&
      withRank[i + j].value === withRank[i + j + 1].value;
      j++
    ) {
      total += withRank[i + j + 1].rank;
      count++;
    }

    const rank = total / count;
    for (let k = 0; k < count; k++) {
      withRank[i + k].rank = rank;
    }

    i = i + count;
  }

  return withRank;
}

/**
 * Compare both elements of `allSamples` and display comparative results.
 * Returns false if any of the tested scenario had a significant performance
 * regression.
 * @returns {Object}
 */
function compareSamples() {
  const samplesPerScenario = {
    current: getSamplePerScenarios(allSamples.current),
    previous: getSamplePerScenarios(allSamples.previous),
  };

  const results = {
    failures: [],
    success: [],
  };
  for (const testName of Object.keys(samplesPerScenario.current)) {
    const sampleCurrent = samplesPerScenario.current[testName];
    const samplePrevious = samplesPerScenario.previous[testName];
    if (samplePrevious === undefined) {
      // eslint-disable-next-line no-console
      console.error("Error: second result misses a scenario:", testName);
      continue;
    }
    const resultCurrent = getResultsForSample(sampleCurrent);
    const resultPrevious = getResultsForSample(samplePrevious);

    const differenceMs = resultPrevious.mean - resultCurrent.mean;
    const differencePc = differenceMs / resultCurrent.mean;
    const uValue = getUValueFromSamples(sampleCurrent, samplePrevious);
    const zScore = Math.abs(
      calculateZScore(uValue, sampleCurrent.length, samplePrevious.length),
    );
    // For p-value of 5%
    // const isSignificant = zScore > 1.96;
    // For p-value of 1%
    const isSignificant = zScore > 2.575829;

    /* eslint-disable no-console */
    console.log("");
    console.log(`> Current results for test:`, testName);
    console.log("");
    console.log("    For current Player:");
    console.log(`      mean: ${resultCurrent.mean}`);
    console.log(`      variance: ${resultCurrent.variance}`);
    console.log(`      standard deviation: ${resultCurrent.standardDeviation}`);
    console.log(`      standard error of mean: ${resultCurrent.standardErrorOfMean}`);
    console.log(`      moe: ${resultCurrent.moe}`);
    console.log("");
    console.log("    For previous Player:");
    console.log(`      mean: ${resultPrevious.mean}`);
    console.log(`      variance: ${resultPrevious.variance}`);
    console.log(`      standard deviation: ${resultPrevious.standardDeviation}`);
    console.log(`      standard error of mean: ${resultPrevious.standardErrorOfMean}`);
    console.log(`      moe: ${resultPrevious.moe}`);
    console.log("");
    console.log("    Results");
    console.log(`      mean difference % (negative is slower): ${differencePc * 100}%`);
    console.log(`      mean difference time (negative is slower): ${differenceMs} ms`);
    if (isSignificant) {
      console.log(`      The difference is significant (z: ${zScore})`);
      if (differenceMs < -2) {
        results.failures.push(testName);
      } else {
        results.success.push(testName);
      }
    } else {
      console.log(`      The difference is not significant (z: ${zScore})`);
      results.success.push(testName);
    }
    console.log("");
  }
  /* eslint-enable no-console */
  return results;
  function calculateZScore(u, len1, len2) {
    return (u - (len1 * len2) / 2) / Math.sqrt((len1 * len2 * (len1 + len2 + 1)) / 12);
  }
}

/**
 * Calculate U value from the Mann–Whitney U test from two samples.
 * @param {Array.<number>} sampleCurrent
 * @param {Array.<number>} samplePrevious
 * @returns {number}
 */
function getUValueFromSamples(sampleCurrent, samplePrevious) {
  const concatSamples = sampleCurrent.concat(samplePrevious);
  const ranked = rankSamples(concatSamples);

  const summedRanks1 = sumRanks(ranked, sampleCurrent);
  const summedRanks2 = sumRanks(ranked, samplePrevious);
  const n1 = sampleCurrent.length;
  const n2 = samplePrevious.length;

  const u1 = calculateUValue(summedRanks1, n1, n2);
  const u2 = calculateUValue(summedRanks2, n2, n1);

  function calculateUValue(rank, currLen, otherLen) {
    return currLen * otherLen + (currLen * (currLen + 1)) / 2 - rank;
  }
  return Math.min(u1, u2);

  function sumRanks(rankedList, observations) {
    const remainingToFind = observations.slice();
    let rank = 0;
    rankedList.forEach(function (observation) {
      const index = remainingToFind.indexOf(observation.value);
      if (index > -1) {
        rank += observation.rank;
        remainingToFind.splice(index, 1);
      }
    });
    return rank;
  }
}

/**
 * Construct a "result object" from the given sample.
 * That object will contain various useful information like the mean,
 * standard deviation, and so on.
 * @param {Array.<number>} sample
 * @returns {Object}
 */
function getResultsForSample(sample) {
  const mean = sample.reduce((acc, x) => acc + x, 0) / sample.length;
  const variance =
    sample.reduce((acc, x) => {
      return acc + Math.pow(x - mean, 2);
    }, 0) /
      (sample.length - 1) || 0;
  const standardDeviation = Math.sqrt(variance);
  const standardErrorOfMean = standardDeviation / Math.sqrt(sample.length);
  const criticalVal = 1.96;
  const moe = standardErrorOfMean * criticalVal;
  return { mean, variance, standardErrorOfMean, standardDeviation, moe };
}

/**
 * Transform the sample object given to divide sample numbers per scenario (the
 * `name` property).
 * In the returned object, keys will be the scenario's name and value will be
 * the array of results (in terms of number) for that scenario.
 * @param {Array.<Object>} samplesObj
 * @returns {Array.<Object>}
 */
function getSamplePerScenarios(samplesObj) {
  return samplesObj.reduce((acc, x) => {
    if (acc[x.name] === undefined) {
      acc[x.name] = [x.value];
    } else {
      acc[x.name].push(x.value);
    }
    return acc;
  }, {});
}

/**
 * Build the performance tests.
 * @param {Object} options
 * @param {Object} options.output - The output file
 * @param {boolean} [options.minify] - If `true`, the output will be minified.
 * @param {boolean} [options.production] - If `false`, the code will be compiled
 * in "development" mode, which has supplementary assertions.
 * @returns {Promise}
 */
function createBundle(options) {
  const minify = !!options.minify;
  const isDevMode = !options.production;
  return esbuild
    .build({
      entryPoints: [path.join(currentDirectory, "src", "main.js")],
      bundle: true,
      minify,
      outfile: path.join(currentDirectory, options.output),
      define: {
        __TEST_CONTENT_SERVER__: JSON.stringify({
          URL: "127.0.0.1",
          PORT: "3000",
        }),
        "process.env.NODE_ENV": JSON.stringify(isDevMode ? "development" : "production"),
        __ENVIRONMENT__: JSON.stringify({
          PRODUCTION: 0,
          DEV: 1,
          CURRENT_ENV: isDevMode ? 1 : 0,
        }),
        __LOGGER_LEVEL__: JSON.stringify({
          CURRENT_LEVEL: "INFO",
        }),
        __GLOBAL_SCOPE__: JSON.stringify(false),
      },
    })
    .catch((err) => {
      throw new Error(`Demo build failed:`, err);
    });
}

/**
 * @param {string} command
 * @param {Array.<string>} args
 * @param {Function|undefined} [errorOnCode]
 * @returns {Object}
 */
function spawnProc(command, args, errorOnCode) {
  let child;
  const prom = new Promise((res, rej) => {
    child = spawn(command, args, { shell: true, stdio: "inherit" });
    child.on("close", (code) => {
      if (code !== 0 && typeof errorOnCode === "function") {
        rej(errorOnCode(code));
      }
      res();
    });
  });
  return {
    promise: prom,
    child,
  };
}

/**
 * Returns string corresponding to the Chrome binary.
 * @returns {Promise.<string>}
 */
async function getChromeCmd() {
  switch (process.platform) {
    case "win32": {
      const suffix = "\\Google\\Chrome\\Application\\chrome.exe";
      const prefixes = [
        process.env.LOCALAPPDATA,
        process.env.PROGRAMFILES,
        process.env["PROGRAMFILES(X86)"],
      ];
      for (const prefix of prefixes) {
        try {
          const windowsChromeDirectory = path.join(prefix, suffix);
          fs.accessSync(windowsChromeDirectory);
          return windowsChromeDirectory;
        } catch (e) {}
      }

      return null;
    }

    case "darwin": {
      const defaultPath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
      try {
        const homePath = path.join(process.env.HOME, defaultPath);
        fs.accessSync(homePath);
        return homePath;
      } catch (e) {
        return defaultPath;
      }
    }

    case "linux": {
      const chromeBins = ["google-chrome", "google-chrome-stable"];
      for (const chromeBin of chromeBins) {
        try {
          await execCommandAndGetFirstOutput(`which ${chromeBin}`);
          return chromeBin;
        } catch (e) {}
      }
      return null;
    }
    default:
      throw new Error("Error: unsupported platform:", process.platform);
  }
}
//
// /**
//  * Returns string corresponding to the Chrome binary.
//  * @returns {Promise.<string>}
//  */
// async function getFirefoxCmd() {
//   switch (process.platform) {
//     case "linux": {
//       return "firefox";
//     }
//     // TODO other platforms
//     default:
//       throw new Error("Error: unsupported platform:", process.platform);
//   }
// }

function execCommandAndGetFirstOutput(command) {
  return new Promise((res, rej) => {
    exec(command, (error, stdout) => {
      if (error) {
        rej(error);
      } else {
        res(stdout);
      }
    });
  });
}

/**
 * Display through `console.log` an helping message relative to how to run this
 * script.
 */
function displayHelp() {
  /* eslint-disable-next-line no-console */
  console.log(
    `Usage: node run.mjs [options]
Available options:
  -h, --help                        Display this help message
  -b <branch>, --branch <branch>    Specify the branch name the performance results should be compared to.
                                    Defaults to the "dev" branch.,
  -u <URL>, --remote-git-url <URL>  Specify the remote git URL where the current repository can be cloned from.
                                    Defaults to the current remote URL.`,
  );
}
