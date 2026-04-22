# edge/simulator

Replay SHDR traces from the cppagent demo corpus. Vendored from
https://github.com/mtconnect/cppagent (Apache-2.0) to keep our integration
tests reproducible without network access.

## Run

```bash
ruby simulator.rb 7878 < mazak.txt
```

The simulator listens on port 7878 and feeds SHDR lines to any connected
client (i.e., cppagent's adapter block pointing at it).
