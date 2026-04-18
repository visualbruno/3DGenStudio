# 3D Gen Studio

`3D Gen Studio` is a creative production workspace for turning ideas into 3D-ready assets.

The application combines **image generation**, **asset management**, and a **kanban-style workflow** to help organize creation from concept to result. With the help of **external image-generation APIs** and **ComfyUI**, users can generate images, manage edits, and transform visual inputs into meshes inside a structured project workflow.

Designed as a visual studio for experimentation and production, `3D Gen Studio` helps keep assets, steps, and outputs organized in one place.

---

## Why 3D Gen Studio?

- Generate images using external AI APIs
- Organize work in a kanban workflow
- Manage image assets, edits, meshes, and reusable workflows
- Connect with `ComfyUI` for advanced generation pipelines
- Build a smoother path from **image concept** to **3D mesh output**

---

## Screenshots

Add your screenshots here.

### Dashboard / Kanban

<img width="2548" height="1352" alt="image" src="https://github.com/user-attachments/assets/8968d0f8-2b70-41d4-870e-4031b1f521f7" />

### Assets Library

<img width="2548" height="1352" alt="image" src="https://github.com/user-attachments/assets/6fa89b0d-c630-4d17-a775-b18fecf9e60b" />
<img width="2548" height="1352" alt="image" src="https://github.com/user-attachments/assets/3d5aeedb-f734-4e98-98f8-d0a965fba187" />

### Mesh Preview / Viewer

<img width="2548" height="1352" alt="image" src="https://github.com/user-attachments/assets/5ad29bb2-1937-45d7-a598-15dd637687a5" />

### Workflow / ComfyUI Integration

<img width="2548" height="1352" alt="image" src="https://github.com/user-attachments/assets/23d045f1-3789-47e7-8fba-22ebdd837b03" />

---

## Installation

### Prerequisites

Before starting, make sure you have:

- `Node.js` and `npm`
- A running `ComfyUI` installation
- Access to at least one external image-generation API

### 1. Clone the repository

```bash
git clone https://github.com/visualbruno/3DGenStudio.git
cd 3DGenStudio
```

### 2. Install dependencies

```bash
npm install
```

### 3. Start the application

```bash
npm run dev
```

This starts:

- the backend server on `http://localhost:3001`
- the Vite frontend development server

### 4. Configure integrations

Open the application and configure your services in the settings area:

- `ComfyUI` path / host / port
- external API credentials
- optional custom endpoints

### 5. Start creating

You can then:

- create and manage projects
- generate images
- review and organize edits
- import assets into the library
- generate or manage meshes in your workflow

---

## Technologies and Frameworks Used

### Frontend

- `React`
- `Vite`
- `React Router`
- `Three.js`
- `@react-three/fiber`
- `@react-three/drei`

### Backend

- `Node.js`
- `Express`
- `Multer`

### Data and Storage

- `SQLite`
- `LowDB`
- local asset storage for images and meshes

### Tooling

- `ESLint`
- `concurrently`

### Integrations

- `ComfyUI`
- external AI image-generation APIs
- custom API endpoints

---

## Project Vision

`3D Gen Studio` aims to make 3D content creation more accessible by combining generation tools, asset tracking, and workflow organization in a single interface. It is built for creators who want a practical bridge between **AI-generated imagery** and **3D production workflows**.

---

### Thank you for your support

[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20A%20Coffee-ffdd00?style=for-the-badge&logo=buy-me-a-coffee&logoColor=black)](https://www.buymeacoffee.com/visualbruno)
