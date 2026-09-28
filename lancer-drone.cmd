@echo off
rem Lance le simulateur Drone Recon : le serveur de developpement, puis le
rem navigateur par defaut sur http://localhost:5173 des qu'il est pret.
rem Laisser cette fenetre ouverte : la fermer arrete le simulateur.
title Drone Recon
cd /d "%~dp0"
if not exist node_modules (
  echo Premiere utilisation : installation des dependances...
  call npm install || goto :erreur
)
call npm run dev -- --open
goto :eof

:erreur
echo.
echo L'installation a echoue : Node.js est-il installe ?
pause
