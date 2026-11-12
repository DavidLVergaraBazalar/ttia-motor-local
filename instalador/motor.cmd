@echo off
rem Lanzador del motor local de THE TOWN IA. Usa el Node que viene con el instalador (carpeta node\).
setlocal
title THE TOWN IA - motor local
"%~dp0node\node.exe" "%~dp0dist\cli.js" %*
set CODIGO=%ERRORLEVEL%
rem Que la ventana no se cierre sola si hubo un error o si fue un comando corto (clave, carpeta).
if not "%CODIGO%"=="0" (
  echo.
  echo El motor termino con un error. Revisa el mensaje de arriba.
  pause
) else if "%~1"=="clave" (
  pause
) else if "%~1"=="carpeta" (
  pause
)
exit /b %CODIGO%
