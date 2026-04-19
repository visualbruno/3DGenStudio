<div align="center">

# 🌌 3D Gen Studio

**The open-source AI-powered 3D mesh production layer.**

[![Website](https://img.shields.io/badge/website-3dgenstudio.com-purple.svg)](https://www.3dgenstudio.com)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/visualbruno/3DGenStudio/pulls)

*Orchestrate complete 3D generation pipelines — from text-to-image, image editing, mesh generation, UV unwrapping, to texturing — all in a single visual workspace powered by ComfyUI and external APIs.*

[**Website**](https://www.3dgenstudio.com) • [**Report Bug**](https://github.com/visualbruno/3DGenStudio/issues)
</div>

---

## ✨ Features

Switch between **Kanban** and **Graph** views to manage and visualize your entire 3D production pipeline in the way that suits your style.

### 📋 Kanban Board
Manage your 3D assets as cards flowing through automated pipeline stages — `Images` → `Image Edit` → `Mesh Gen` → `Mesh Edit` → `Texturing`.
- 🗂️ **Drag-and-drop** cards between pipeline stages
- 🎠 **In-card image carousel** with variant browsing
- ⚡ **Per-card ComfyUI & API** action triggers
- 🏷️ **Custom attributes** & metadata tagging

### 🕸️ Node Graph
Visualize the relationships between your assets as a node graph. Connect image sources to edit nodes, mesh generators, and export pipelines.
- 👁️ **Visual node-based** asset relationships
- 🔍 **Click any node** to open the inspector panel
- 🎛️ **ComfyUI workflow parameters** inline
- 🚀 **Start workflows** with one click

### 📚 Assets Library
A centralized library for all your images, meshes, and ComfyUI workflows. Browse, filter, and import assets directly into any project.
- 📦 **Unified view:** Images, Meshes, Workflows
- ⏱️ **Version tracking** per asset
- 📥 **One-click import** into project
- 📄 **File format badges** (PNG, GLB, OBJ, EXR)

### 🔌 Powerful Integrations
-  **ComfyUI Native:** Run any ComfyUI workflow directly from a card or node. Pass dynamic parameters, capture outputs, and chain results automatically.
-  **External API Support:** Integrate any REST or GraphQL API. Tag cards with API endpoints and trigger generation via any 3rd party 3D service.

### 💾 Local-First Storage
Projects are stored as locally on disk — Git-syncable, portable across machines, and strictly no cloud lock-in.

---

## 🚀 Workflow

Each stage feeds the next. Use **ComfyUI** workflows or external APIs at any step — the results automatically flow to the next card in your board!

1. **Create / Import an Image:** Start with a text-to-image generation via ComfyUI, import an existing asset, or use an external API. Results land in the Images column.
2. **Edit & Refine:** Apply image edits — inpainting, normal map generation, background removal. Cards automatically move to Image Edit.
3. **Generate 3D Mesh:** Trigger a mesh generation workflow (e.g. TripoSR, Wonder3D). GLB/OBJ output moves the card to Mesh Gen.
4. **UV & Texture:** Run automatic UV unwrapping and texture projection workflows. Layer multiple textures, apply normal maps, and preview results.
5. **Export & Publish:** Export your finished mesh as GLB, OBJ, or EXR directly to your library. Track real-time status in the Action Log.

---

## 📸 Showcase

<details open>
<summary><b>Kanban Dashboard</b></summary>
<br>
<img width="100%" alt="Kanban Dashboard" src="https://github.com/user-attachments/assets/8968d0f8-2b70-41d4-870e-4031b1f521f7" />
</details>

<details>
<summary><b>Assets Library</b></summary>
<br>
<img width="100%" alt="Assets Library 1" src="https://github.com/user-attachments/assets/6fa89b0d-c630-4d17-a775-b18fecf9e60b" />
<img width="100%" alt="Assets Library 2" src="https://github.com/user-attachments/assets/3d5aeedb-f734-4e98-98f8-d0a965fba187" />
</details>

<details>
<summary><b>Mesh Preview / Viewer</b></summary>
<br>
<img width="100%" alt="Mesh Preview" src="https://github.com/user-attachments/assets/5ad29bb2-1937-45d7-a598-15dd637687a5" />
</details>

<details>
<summary><b>Workflow / ComfyUI Integration</b></summary>
<br>
<img width="100%" alt="Workflow" src="https://github.com/user-attachments/assets/23d045f1-3789-47e7-8fba-22ebdd837b03" />
</details>

---

## 🛠️ Installation

### Prerequisites
Before starting, make sure you have:
- `Node.js` and `npm` installed
- A running `ComfyUI` installation

### Quick Start

```bash
# 1. Clone the repository
git clone https://github.com/visualbruno/3DGenStudio.git
cd 3DGenStudio

# 2. Install dependencies
npm install

# 3. Start the application
npm run dev
```

> [!NOTE] 
> This starts the backend server on `http://localhost:3001` and the Vite frontend development server.

### Configuration
Open the application and configure your services in the settings area:
- `ComfyUI` path / host / port
- External API credentials
- Optional custom endpoints

---

## 💻 Tech Stack

| Domain | Technologies |
| :--- | :--- |
| **Frontend** | React, Vite, React Router, Three.js, `@react-three/fiber`, `@react-three/drei` |
| **Backend** | Node.js, Express, Multer |
| **Data & Storage** | SQLite, LowDB, Local Asset Storage |
| **Integrations** | ComfyUI, External AI APIs, REST/GraphQL |

---

## Documentation

You will find some documentation here: https://github.com/visualbruno/3DGenStudio/tree/main/docs

---

## 🤝 Contributing & Support

Have a question or an idea? Whether you want to report a bug, suggest a feature, or just say hello:
- 🐛 [Open an issue on GitHub](https://github.com/visualbruno/3DGenStudio/issues)
- 💬 [Start a Discussion](https://github.com/visualbruno/3DGenStudio/discussions)


### Support the Project!
[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20A%20Coffee-ffdd00?style=for-the-badge&logo=buy-me-a-coffee&logoColor=black)](https://www.buymeacoffee.com/visualbruno)

<p align="center">
  <br>
  <b><a href="https://www.3dgenstudio.com/privacy-policy.html">Privacy Policy</a></b> •
  <b><a href="https://www.3dgenstudio.com/terms-and-conditions.html">Terms of Service</a></b>
</p>
