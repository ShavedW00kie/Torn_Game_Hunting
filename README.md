# Project Name

Brief description of what this application does.

## 🚀 Quick Start (Local)
1. Create a virtual environment: `python -m venv .venv`
2. Activate it: `.venv\Scripts\activate` (Windows)
3. Install requirements: `pip install -r requirements.txt`
4. Run the app: `streamlit run app.py`

## 🐳 Docker Deployment
To deploy this application to the local server infrastructure:
```bash
docker build -t app-name .
docker run -d -p 8501:8501 --name app-container app-name
