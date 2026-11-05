@echo off
set A2A_PROBE_EXEC=1
set A2A_PROBE_EXEC_FILE=E:\dsh-a2a-bus\probe-exec.json
set DSH_HOME=C:\Users\niukl\.dsh-a2a-dev
cd /d E:\dsh-a2a-bus
dsh web --port 3091 --host 127.0.0.1 --no-open > C:\Users\niukl\.dsh-a2a-dev\out.log 2> C:\Users\niukl\.dsh-a2a-dev\err.log
