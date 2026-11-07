- **CI test jobs fail after a bounded time instead of hanging (Closes #799).**

  Every job in `.github/workflows/test.yml` that runs a suite or a test-like
  lane sets `timeout-minutes`, and a structure test fails a job that sets none
  and is named neither as covered nor exempt.
