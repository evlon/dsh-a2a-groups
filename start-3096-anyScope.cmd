@echo off
set A2A_CONFIRM_ANY_SCOPE=1
set DSH_HOME=C:\Users\niukl\.dsh-a2a-dev3
cd /d E:\dsh-a2a-bus
dsh web --port 3096 --host 127.0.0.1 --no-open > C:\Users\niukl\.dsh-a2a-dev3\out.log 2> C:\Users\niukl\.dsh-a2a-dev3\err.log
