@echo off
:: Start the 3D Gen Studio Python mesh-processing service.
:: Creates a local virtual environment on first run, installs deps, then serves.
setlocal
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
  echo Creating virtual environment...
  python -m venv .venv
  call ".venv\Scripts\activate.bat"
  python -m pip install --upgrade pip
  pip install -r requirements.txt
) else (
  call ".venv\Scripts\activate.bat"
)

:: Override host/port via env if needed, e.g. set MESHTOOLS_PORT=8200
python main.py

endlocal
