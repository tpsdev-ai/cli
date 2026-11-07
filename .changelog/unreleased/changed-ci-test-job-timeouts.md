- **CI test jobs fail after a bounded time instead of hanging (Closes #799).**

  Every job in `.github/workflows/test.yml` sets `timeout-minutes`; a structure
  test fails a job that omits it or is not named in the test.
