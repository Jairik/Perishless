# Backend Docker File - Install dependencies and startup API endpoints
FROM python:3.12-slim

# Install system dependencies and cleanup apt cache to reduce image size
RUN apt-get update && apt-get install -y --no-install-recommends \
    tesseract-ocr \
    opencv-python-headless \
    libglib2.0-0 \
    libsm6 \
    libxext6 \
    libxrender1 \
    libxcb1 \
    && rm -rf /var/lib/apt/lists/*

# Set working directory and download dependencies
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy all backend source code over
COPY backend/. .

# Start the Uvicorn app on port 8000
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]