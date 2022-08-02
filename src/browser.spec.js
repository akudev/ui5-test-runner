const output = require('./output')
const { join } = require('path')
const { reset, mock } = require('child_process')
const jobFactory = require('./job')
const { probe, start, stop, screenshot } = require('./browsers')
const { readFile, writeFile } = require('fs/promises')
const { createDir, allocPromise } = require('./tools')
const { read } = require('fs')

const cwd = '/test/project'
const tmp = join(__dirname, '../tmp')

describe('src/browser', () => {
  let job

  beforeEach(() => {
    job = jobFactory.fromCmdLine(cwd, [
      '-url:about:blank',
      `-tstReportDir:${join(tmp, 'browser')}`,
      '--',
      'argument1',
      'argument2'
    ])
  })

  afterEach(reset)

  describe('probe', () => {
    it('starts the command with a specific config file', async () => {
      let config
      mock({
        api: 'fork',
        scriptPath: job.browser,
        exec: async childProcess => {
          config = JSON.parse((await readFile(childProcess.args[0])).toString())
          await writeFile(config.capabilities, '{}')
        }
      })
      await probe(job)
      expect(config.url).toStrictEqual('about:blank')
      expect(job.browserCapabilities.console).toStrictEqual(false)
    })

    it('fails if the browser does not generate capabilities', async () => {
      mock({
        api: 'fork',
        scriptPath: job.browser,
        exec: () => {}
      })
      await expect(probe(job)).rejects.toMatchObject({
        name: 'UTRError',
        message: 'MISSING_OR_INVALID_BROWSER_CAPABILITIES'
      })
    })

    it('reads and merge browser capabilities', async () => {
      mock({
        api: 'fork',
        scriptPath: job.browser,
        exec: async childProcess => {
          const config = JSON.parse((await readFile(childProcess.args[0])).toString())
          await writeFile(config.capabilities, JSON.stringify({
            screenshot: false,
            console: true
          }))
        }
      })
      await probe(job)
      expect(job.browserCapabilities.console).toStrictEqual(true)
      expect(job.browserCapabilities.parallel).toStrictEqual(true)
    })

    describe('dependent modules', () => {
      const npmLocal = join(tmp, 'npm/local')
      const npmGlobal = join(tmp, 'npm/global')

      beforeEach(async () => {
        await createDir(npmGlobal)
        mock({
          api: 'exec',
          scriptPath: 'npm',
          args: ['root', '--global'],
          exec: childProcess => childProcess.stdout.write(npmGlobal)
        })
        await createDir(join(npmLocal, 'localModule'))
        mock({
          api: 'exec',
          scriptPath: 'npm',
          args: ['root'],
          exec: childProcess => childProcess.stdout.write(npmLocal)
        })
      })

      it('handles dependent modules', async () => {
        mock({
          api: 'exec',
          scriptPath: 'npm',
          args: ['install', 'globalModule', '-g'],
          exec: childProcess => childProcess.stdout.write('OK')
        })
        mock({
          api: 'fork',
          scriptPath: job.browser,
          exec: async childProcess => {
            const config = JSON.parse((await readFile(childProcess.args[0])).toString())
            await writeFile(config.capabilities, JSON.stringify({
              modules: ['localModule', 'globalModule']
            }))
          }
        })
        await probe(job)
        expect(job.browserCapabilities.modules.localModule).toStrictEqual(join(npmLocal, 'localModule'))
        expect(job.browserCapabilities.modules.globalModule).toStrictEqual(join(npmGlobal, 'globalModule'))
      })

      it('fails if a dependent module cannot be installed', async () => {
        mock({
          api: 'exec',
          scriptPath: 'npm',
          args: ['install', 'globalModule', '-g'],
          exec: childProcess => {
            childProcess.stdout.write('KO')
            childProcess.close(-1)
          },
          close: false
        })
        mock({
          api: 'fork',
          scriptPath: job.browser,
          exec: async childProcess => {
            const config = JSON.parse((await readFile(childProcess.args[0])).toString())
            await writeFile(config.capabilities, JSON.stringify({
              modules: ['localModule', 'globalModule']
            }))
          }
        })
        await expect(probe(job)).rejects.toMatchObject({
          name: 'UTRError',
          message: 'NPM_FAILED'
        })
      })
    })
  })

  describe('start and stop', () => {
    let remainingChildProcess

    beforeEach(() => {
      job.browserCapabilities = {}
    })

    afterEach(async () => {
      if (remainingChildProcess) {
        remainingChildProcess.close()
        await remainingChildProcess.closed
      }
    })

    it('returns a promise resolved on stop (even if the child process remains)', async () => {
      mock({
        api: 'fork',
        scriptPath: job.browser,
        exec: async childProcess => {
          remainingChildProcess = childProcess
          setTimeout(() => stop(job, '/test.html'), 0)
        },
        close: false
      })
      await start(job, '/test.html')
    })

    it('passes URL to open', async () => {
      let config
      mock({
        api: 'fork',
        scriptPath: job.browser,
        exec: async childProcess => {
          remainingChildProcess = childProcess
          config = JSON.parse((await readFile(childProcess.args[0])).toString())
          setTimeout(() => stop(job, '/test.html'), 0)
        },
        close: false
      })
      await start(job, '/test.html')
      expect(config.url).toStrictEqual('/test.html')
    })

    it('passes browser arguments', async () => {
      let config
      mock({
        api: 'fork',
        scriptPath: job.browser,
        exec: async childProcess => {
          remainingChildProcess = childProcess
          config = JSON.parse((await readFile(childProcess.args[0])).toString())
          setTimeout(() => stop(job, '/test.html'), 0)
        },
        close: false
      })
      await start(job, '/test.html')
      expect(config.args).toEqual(['argument1', 'argument2'])
    })

    it('captures outputs', async () => {
      let child
      mock({
        api: 'fork',
        scriptPath: job.browser,
        exec: async childProcess => {
          child = childProcess
          childProcess.stdout.write('stdout')
          childProcess.stderr.write('stderr')
          setTimeout(() => stop(job, '/test.html'), 0)
        }
      })
      await start(job, '/test.html')
      const stdout = (await readFile(child.stdoutFilename)).toString()
      expect(stdout).toStrictEqual('stdout')
      const stderr = (await readFile(child.stderrFilename)).toString()
      expect(stderr).toStrictEqual('stderr')
    })

    it('stops automatically after a timeout', async () => {
      const { promise: waitingForStop, resolve: stopReceived } = allocPromise()
      mock({
        api: 'fork',
        scriptPath: job.browser,
        exec: async childProcess => {
          childProcess.on('message.received', message => {
            if (message.command === 'stop') {
              childProcess.close()
              stopReceived()
            }
          })
        },
        close: false
      })
      job.pageTimeout = 100
      await Promise.all([
        start(job, '/test.html'),
        waitingForStop
      ])
    })

    it('retries on abnormal termination', async () => {
      let config
      mock({
        api: 'fork',
        scriptPath: job.browser,
        exec: async childProcess => {
          config = JSON.parse((await readFile(childProcess.args[0])).toString())
          if (config.retry === 0) {
            childProcess.close(-1)
          }
          setTimeout(() => stop(job, '/test.html'), 0)
        },
        close: false
      })
      await start(job, '/test.html')
      expect(config.retry).toStrictEqual(1)
    })

    it('ignores unknown pages', async () => {
      job.browsers = {}
      await stop(job, '/unknown.html')
    })
  })

  describe('script injection', () => {
  })

  return

  describe('screenshot', () => {

  })

  it('supports screenshot', () => {
    hook.once('new', childProcess => {
      childProcess.on('message.received', message => {
        if (message.command === 'screenshot') {
          expect(message.filename).toStrictEqual('screenshot.png')
          setTimeout(() => {
            childProcess.emit('message', message)
          }, 0)
        }
      })
      setTimeout(async () => {
        await screenshot(job, 'test.html', 'screenshot.png')
        stop(job, 'test.html')
      }, 0)
    })
    return start(job, 'test.html')
  })

  it('supports screenshot (noScreenshot)', () => {
    job.noScreenshot = true
    hook.once('new', childProcess => {
      childProcess.on('message.received', message => {
        expect(message.command).not.toStrictEqual('screenshot')
      })
      setTimeout(async () => {
        await screenshot(job, 'test.html', 'screenshot.png')
        job.noScreenshot = false
        stop(job, 'test.html')
      }, 0)
    })
    return start(job, 'test.html')
  })

  it('supports screenshot (page does not exist)', async () => {
    await expect(screenshot(job, 'test2.html', 'screenshot.png')).resolve
  })

  it('supports screenshot (page disconnected)', async () => {
    job.browserCapabilities = { screenshot: true }
    hook.once('new', childProcess => {
      childProcess.on('message.received', message => {
        expect(message.command).not.toStrictEqual('screenshot')
      })
      setTimeout(async () => {
        childProcess._connected = false
        await screenshot(job, 'test.html', 'screenshot.png')
        stop(job, 'test.html')
      }, 0)
    })
    return start(job, 'test.html')
  })

  describe('automatic retry', () => {

  })

  it('retries automatically if the process crashes unexpectedly (second succeeds)', () => {
    let step = 0
    hook.once('new', childProcess => {
      step = 1
      setTimeout(() => childProcess.close(), 100)
      hook.once('new', () => {
        step = 2
        setTimeout(() => stop(job, 'test.html'))
      })
    })
    job.pageTimeout = 1000
    return start(job, 'test.html')
      .then(() => {
        expect(step).toStrictEqual(2)
      })
  })

  it('retries automatically if the process crashes unexpectedly (second also fails)', () => {
    let step = 0
    hook.once('new', childProcess => {
      step = 1
      setTimeout(() => childProcess.close(), 100)
      hook.once('new', childProcess => {
        step = 2
        setTimeout(() => childProcess.close(), 100)
      })
    })
    job.pageTimeout = 1000
    return start(job, 'test.html')
      .then(() => {
        expect(step).toStrictEqual(2)
      })
  })
})
