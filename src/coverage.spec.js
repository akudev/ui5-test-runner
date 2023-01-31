const { join } = require('path')
const { fromObject } = require('./job')
const { instrument, generateCoverageReport, mappings } = require('./coverage')
const { stat } = require('fs/promises')
const { cleanDir, createDir } = require('./tools')

describe('src/coverage', () => {
  const cwd = join(__dirname, '../test/project')
  const path = join(__dirname, '../tmp/coverage')

  beforeAll(() => {
    return cleanDir(path)
  })

  describe('disabled', () => {
    const basePath = join(path, 'disabled')
    let job

    beforeAll(async () => {
      const reportDir = join(basePath, 'report')
      await createDir(reportDir)
      job = fromObject(cwd, {
        reportDir,
        coverageTempDir: join(basePath, 'coverage/temp'),
        coverageReportDir: join(basePath, 'coverage/report'),
        coverage: false
      })
    })

    it('does not instrument sources', async () => {
      await instrument(job)
      await expect(() => stat(join(basePath, 'coverage/temp/settings/nyc.json'))).rejects.toThrow()
    })

    it('does not generate a report', async () => {
      await generateCoverageReport(job)
      await expect(() => stat(join(basePath, 'coverage/temp/coverage.json'))).rejects.toThrow()
      await expect(() => stat(join(basePath, 'coverage/report'))).rejects.toThrow()
    })

    it('does not create a mapping', async () => {
      const coverageMappings = mappings(job)
      expect(coverageMappings.length).toStrictEqual(0)
    })
  })

  describe('enabled', () => {
    const basePath = join(path, 'enabled')
    let job

    beforeAll(async () => {
      const reportDir = join(basePath, 'report')
      await createDir(reportDir)
      job = fromObject(cwd, {
        reportDir,
        coverageTempDir: join(basePath, 'coverage/temp'),
        coverageReportDir: join(basePath, 'coverage/report'),
        coverage: true
      })
    })

    it('instruments sources', async () => {
      await instrument(job)
      const nycJsonStat = await stat(join(basePath, 'coverage/temp/settings/nyc.json'))
      expect(nycJsonStat.isFile()).toStrictEqual(true)
    })

    it('generates a report', async () => {
      await generateCoverageReport(job)
      const reportStat = await stat(join(basePath, 'coverage/report'))
      expect(reportStat.isDirectory()).toStrictEqual(true)
    })

    it('creates a mapping', async () => {
      const coverageMappings = mappings(job)
      expect(coverageMappings.length).toStrictEqual(1)
    })
  })
})