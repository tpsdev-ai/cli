- **CI test jobs fail after a bounded time instead of hanging (Closes #799).**

  Every job in `.github/workflows/test.yml` today is covered and sets
  `timeout-minutes`; a structure test fails a covered job that omits it or a
  job not named in the test. An exempt job may omit a timeout but needs a reason
  in the test.
