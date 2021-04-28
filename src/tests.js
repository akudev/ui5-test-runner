'use strict'

const { start } = require('./browsers')
const { generateCoverageReport } = require('./coverage')
const { recreateDir } = require('./tools')
const { join } = require('path')
const { copyFile } = require('fs').promises

const job = require('./job')

async function extractTestPages () {
  job.status = 'Extracting test pages'
  await recreateDir(job.tstReportDir)
  await start('/test/testsuite.qunit.html')
  job.testPagesStarted = 0
  job.testPagesCompleted = 0
  job.testPages = {}
  job.status = 'Executing test pages'
  for (let i = 0; i < job.parallel; ++i) {
    runTestPage()
  }
}

async function runTestPage () {
  const { length } = job.testPageUrls
  if (job.testPagesCompleted === length) {
    return generateReport()
  }
  if (job.testPagesStarted === length) {
    return
  }
  const index = job.testPagesStarted++
  const url = job.testPageUrls[index]
  await start(url)
  ++job.testPagesCompleted
  runTestPage()
}

async function generateReport () {
  job.status = 'Finalizing'
  // Simple report
  let failed = 0
  const pages = []
  for (const url of job.testPageUrls) {
    const page = job.testPages[url]
    if (page && page.report) {
      pages.push({
        url,
        failed: page.report.failed
      })
      failed += page.report.failed
    } else {
      pages.push({
        url,
        failed: -1
      })
      failed += 1
    }
  }
  console.table(pages)
  await copyFile(join(__dirname, 'report.html'), join(job.tstReportDir, 'report.html'))
  await generateCoverageReport()
  console.log(`Time spent: ${new Date() - job.start}ms`)
  if (job.keepAlive) {
    console.log('Keeping alive.')
  } else {
    process.exit(failed)
  }
}

if (!job.parallel) {
  module.exports = () => {}
} else {
  module.exports = extractTestPages
}
