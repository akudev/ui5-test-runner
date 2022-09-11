'use strict'

const { screenshot } = require('./browsers')

function getTest ({ tests }, testId) {
  let test = tests.find(({ id }) => id === testId)
  if (!test) {
    test = {
      id: testId
    }
    tests.push(test)
  }
  return test
}

module.exports = {
  async begin (job, url, { isOpa, totalTests, modules }) {
    if (!job.qunitPages) {
      job.qunitPages = {}
    }
    const qunitPage = {
      isOpa,
      failed: 0,
      passed: 0,
      tests: []
    }
    modules.forEach(module => {
      module.tests.forEach(test => getTest(qunitPage, test.testId))
    })
    job.qunitPages[url] = qunitPage
  },

  async log (job, url, { testId, runtime }) {
    const qunitPage = job.qunitPages[url]
    if (qunitPage.isOpa && job.browserCapabilities.screenshot) {
      const test = getTest(qunitPage, testId)
      if (!test.screenshots) {
        test.screenshots = []
      }
      test.screenshots.push(runtime)
      await screenshot(job, url, `${testId}-${runtime}`)
    }
  }
}
