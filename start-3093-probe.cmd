@echo off
set A2A_PROBE_EXEC=1
set A2A_PROBE_EXEC_FILE=E:\dsh-a2a-bus\probe-3093.json
set DSH_HOME=C:\Users\niukl\.dsh-a2a-dev2
cd /d E:\dsh-a2a-bus
dsh web --port 3093 --host 127.0.0.1 --no-open > C:\Users\niukl\.dsh-a2a-dev2\out.log 2> C:\Users\niukl\.dsh-a2a-dev2\err.log
