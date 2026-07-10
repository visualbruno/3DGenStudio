@echo off
:: Start the 3D Gen Studio Python mesh-processing service.
:: On first run: creates a local virtual environment, installs the base (CPU)
:: requirements, then auto-detects an NVIDIA GPU and installs matching GPU
:: acceleration (Warp + the correct cupy-cudaXXx wheel for your CUDA version).
setlocal enabledelayedexpansion
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
  call :setup || goto :error
) else (
  call ".venv\Scripts\activate.bat"
)

:: Override host/port via env if needed, e.g. set MESHTOOLS_PORT=8200
python main.py
goto :eof


:setup
echo Creating virtual environment...
python -m venv .venv || exit /b 1
call ".venv\Scripts\activate.bat"
python -m pip install --upgrade pip

echo.
echo Installing base (CPU) requirements...
pip install -r requirements.txt || exit /b 1

:: --- Optional NVIDIA GPU acceleration -------------------------------------
:: detect_cuda.py prints the matching CuPy wheel (e.g. cupy-cuda13x) when an
:: NVIDIA GPU is present, or nothing otherwise. Force a specific wheel with
:: MESHTOOLS_CUPY_PACKAGE, or skip GPU deps entirely with MESHTOOLS_SKIP_GPU=1.
echo.
if defined MESHTOOLS_SKIP_GPU (
  echo MESHTOOLS_SKIP_GPU set -- skipping GPU acceleration ^(CPU-only install^).
  exit /b 0
)

echo Detecting NVIDIA GPU / CUDA version...
set "CUPY_PKG="
for /f "usebackq delims=" %%p in (`python detect_cuda.py`) do set "CUPY_PKG=%%p"

if defined CUPY_PKG (
  echo NVIDIA GPU detected -- installing GPU acceleration: !CUPY_PKG! + Warp
  pip install -r requirements-nvidia.txt || exit /b 1
  pip install "!CUPY_PKG!" || exit /b 1
  echo GPU acceleration installed.
) else (
  echo No NVIDIA GPU detected -- CPU-only install. Auto Retopo will run on the CPU.
)
exit /b 0


:error
echo.
echo Setup failed. See the messages above.
exit /b 1
