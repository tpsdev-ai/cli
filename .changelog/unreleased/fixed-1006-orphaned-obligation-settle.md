- **Recovery settles an open reply obligation whose inbox record is gone.** A
  missing `cur/` entry no longer leaves the obligation open: recovery settles it
  from the obligation record (a receipt, or the deadline verdict with one nack to
  the recorded sender), and the archiver keeps `cur/` while its obligation is
  non-terminal.
