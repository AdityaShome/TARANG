@echo off
echo Starting Tarang B2 Cache Server...
echo This uses rclone to serve the cached NetCDF files over HTTP.
echo Keep this window open while using the "CACHED" mode in Tarang.
echo.

rclone serve http b2readonly:tarang-cache --addr 127.0.0.1:8080

pause
