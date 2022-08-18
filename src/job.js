'use strict'

const { Command, Option, InvalidArgumentError } = require('commander')
const { statSync, accessSync, constants } = require('fs')
const { join, isAbsolute } = require('path')
const output = require('./output')
const { name, description, version } = require(join(__dirname, '../package.json'))

function buildArgs (parameters) {
  const before = []
  const after = []
  let browser = []
  Object.keys(parameters).forEach(name => {
    if (name === '--') {
      return
    }
    const value = parameters[name]
    let args
    if (name.startsWith('!')) {
      args = after
      name = name.substring(1)
    } else {
      args = before
    }
    args.push(`-${name}`)
    if (value !== null) {
      if (Array.isArray(value)) {
        args.push(...value)
      } else {
        args.push(value)
      }
    }
  })
  if (parameters['--']) {
    browser = parameters['--']
  }
  const stringify = args => args.map(value => value.toString())
  return {
    before: stringify(before),
    after: stringify(after),
    browser: stringify(browser)
  }
}

function parse (cwd, args) {
  function integer (value) {
    const result = parseInt(value, 10)
    if (result < 0) {
      throw new InvalidArgumentError('Only >= 0')
    }
    return result
  }

  function boolean (value) {
    return ['true', 'yes', 'on'].includes(value)
  }

  function url (value) {
    if (!value.match(/^https?:\/\/[^ "]+$/)) {
      throw new InvalidArgumentError('Invalid URL')
    }
    return value
  }

  const command = new Command()
  command.exitOverride()
  command
    .name(name)
    .description(description)
    .version(version)
    .addOption(
      new Option('-cwd <path>', 'Current working directory')
        .default(cwd, 'current working directory')
    )
    .option('-port <port>', 'Port to use (0 to use a free one)', integer, 0)
    .option('-ui5 <url>', 'UI5 url', url, 'https://ui5.sap.com')
    .option('-libs <path...>', 'Library mapping', function lib (value, previousValue) {
      let result
      if (previousValue === undefined) {
        result = []
      } else {
        result = [...previousValue]
      }
      if (value.includes('=')) {
        const [relative, source] = value.split('=')
        result.push({ relative, source })
      } else {
        result.push({ relative: '', source: value })
      }
      return result
    })
    .option('-cache <path>', 'Cache UI5 resources locally in the given folder (empty to disable)')
    .option('-webapp <path>', 'Base folder of the web application (relative to cwd)', 'webapp')
    .option('-testsuite <path>', 'Path of the testsuite file (relative to webapp)', 'test/testsuite.qunit.html')
    .option('-url <url...>', 'URL of the testsuite / page to test', url)

    .option('-pageFilter <regexp>', 'Filters which pages to execute')
    .option('-pageParams <params>', 'Parameters added to each page URL')
    .option('-pageTimeout <timeout>', 'Limit the page execution time (ms), fails the page if it takes longer than the timeout (0 to disable the timeout)', integer, 0)
    .option('-globalTimeout <timeout>', 'Limit the pages execution time (ms), fails the page if it takes longer than the timeout (0 to disable the timeout)', integer, 0)
    .option('-failFast [flag]', 'Stops the execution after the first failing page', boolean, false)
    .option('-keepAlive [flag]', 'Keeps the server alive (enables debugging)', boolean, false)
    .option('-watch [flag]', 'Monitors the webapp folder and re-execute tests on change', boolean, false)
    .option('-logServer [flag]', 'Logs server traces', boolean, false)

    .option('-browser <command>', 'Browser instantiation command', join(__dirname, '../defaults/puppeteer.js'))
    .option('-browserArgs <argument...>', 'Browser instantiation command parameters')

    .option('-browserRetry <count>', 'Browser instantiation retries : if the command fails unexpectedly, it is re-executed (0 means no retry)', 1)
    .option('-noScreenshot', 'No screenshot is taken during the tests execution', boolean, false)
    .option('-screenshotTimeout <timeout>', 'Maximum waiting time (ms) for browser screenshot', 2000)

    .option('-parallel <count>', 'Number of parallel tests executions (0 to ignore tests and keep alive)', 2)
    .option('-tstReportDir <path>', 'Directory to output test reports (relative to cwd)', 'report')

    .option('-coverage [flag]', 'Enable or disable code coverage', boolean, true)
    .option('-covSettings <path>', 'Path to a custom nyc.json file providing settings for instrumentation (relative to cwd)', join(__dirname, '../defaults/nyc.json'))
    .option('-covTempDir <path>', 'Directory to output raw coverage information to (relative to cwd)', '.nyc_output')
    .option('-covReportDir <path>', 'Directory to store the coverage report files (relative to cwd)', 'coverage')
    .option('-covReporters <reporter...>', 'List of reporters to use', ['lcov', 'cobertura'])

  command.parse(args, { from: 'user' })
  const options = command.opts()
  return Object.keys(options).reduce((result, name) => {
    result[name.charAt(0).toLocaleLowerCase() + name.substring(1)] = options[name]
    return result
  }, {
    initialCwd: cwd,
    browserArgs: command.args
  })
}

function checkAccess ({ path, label, file /*, write*/ }) {
  try {
    const mode = constants.R_OK
    // if (write) {
    //   mode |= constants.W_OK
    // }
    accessSync(path, mode)
  } catch (error) {
    throw new Error(`Unable to access ${label}, check your settings`)
  }
  const stat = statSync(path)
  if (file) {
    if (!stat.isFile()) {
      throw new Error(`Unable to access ${label}, file expected`)
    }
  } else {
    if (!stat.isDirectory()) {
      throw new Error(`Unable to access ${label}, folder expected`)
    }
  }
}

function finalize (job) {
  function toAbsolute (path, from = job.cwd) {
    if (!isAbsolute(path)) {
      return join(from, path)
    }
    return path
  }

  function updateToAbsolute (member, from = job.cwd) {
    job[member] = toAbsolute(job[member], from)
  }

  updateToAbsolute('cwd', job.initialCwd)
  'webapp,browser,tstReportDir,covSettings,covTempDir,covReportDir'
    .split(',')
    .forEach(setting => updateToAbsolute(setting))
  if (!job.url) {
    checkAccess({ path: job.webapp, label: 'webapp folder' })
    const testsuitePath = toAbsolute(job.testsuite, job.webapp)
    checkAccess({ path: testsuitePath, label: 'testsuite', file: true })
  }
  checkAccess({ path: job.browser, label: 'browser command', file: true })

  if (!job.libs) {
    job.libs = []
  } else {
    job.libs.forEach(libMapping => {
      libMapping.source = toAbsolute(libMapping.source)
      let description
      if (libMapping.relative) {
        description = `lib mapping of ${libMapping.relative}`
      } else {
        description = 'generic lib mapping'
      }
      checkAccess({ path: libMapping.source, label: `${description} (${libMapping.source})` })
    })
  }

  if (job.parallel <= 0) {
    job.keepAlive = true
  }
}

module.exports = {
  fromCmdLine (cwd, args) {
    let job = parse(cwd, args)

    const defaultPath = join(job.cwd, 'ui5-test-runner.json')
    let hasDefaultSettings = false
    try {
      checkAccess({ path: defaultPath, file: true })
      hasDefaultSettings = true
    } catch (e) {
      // ignore
    }
    if (hasDefaultSettings) {
      const defaults = require(defaultPath)
      const { before, after, browser } = buildArgs(defaults)
      const sep = args.indexOf('--')
      if (sep === -1) {
        args = [...before, ...args, ...after, '--', ...browser]
      } else {
        args = [...before, ...args.slice(0, sep), ...after, '--', ...browser, ...args.slice(sep + 1)]
      }
      job = parse(cwd, args)
    }

    finalize(job)
    return job
  },

  fromObject (cwd, parameters) {
    const { before, browser } = buildArgs(parameters)
    if (browser.length) {
      return this.fromCmdLine(cwd, [...before, '--', ...browser])
    }
    return this.fromCmdLine(cwd, [...before])
  }
}
