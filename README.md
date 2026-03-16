# Style_it: Your Premium Visual Style Coach

**Style_it** is an advanced, multimodal AI-powered fashion transition coach designed to elevate your personal aesthetic. Leveraging the **Gemini 2.5 Flash Multimodal Live API**, Style_it provides real-time, interactive coaching through voice, video, and text to help you transition from your current look to your dream aesthetic.

---

## 🌟 Key Features

### 🎙️ Multimodal Live Interaction
- **Real-time Voice Coaching**: Talk directly to your stylist. The AI responds with natural, high-quality vocal advice (PCM 24kHz).
- **Vision-Enabled Analysis**: Show your outfit via your camera or upload a photo. The AI "sees" what you're wearing and provides immediate feedback.
- **Natural Interruption**: Speak at any time to interrupt the AI, just like a real conversation.

### 👗 Target Aesthetic Transition
- **Personalized Goals**: Set a "Target Style" (e.g., *Quiet Luxury*, *90s Minimalism*, *Grunge*) and receive tailored advice to achieve it.
- **Inspiration Matching**: Upload an inspiration image to give the AI a visual target for your transformation.

### 🖼️ Dynamic Style Discovery
- **AI-Generated Gallery**: Receive a batch of 6 recommended items matching your target aesthetic.
- **Visual Previews**: High-quality fashion imagery generated dynamically via **Pollinations.ai**.
- **Integrated Shopping**: One-click access to **Google Shopping** for every recommended item.

### 📂 Virtual Closet & Albums
- **Curated Collections**: "Like" recommendations to save them into your personalized closet.
- **Style Albums**: Your saved items are automatically grouped by the aesthetic goal you were pursuing at the time.

### 📈 Fashion Trend Intelligence
- **Live Trends**: Stay ahead with real-time fashion topics fetched via the **Google Trends API**.
- **Impact Analysis**: Analyze how global trends fit into your personal style journey.

---

## 🏗️ Architecture & Tech Stack

### Frontend
- **Framework**: React 19 + TypeScript
- **Build Tool**: Vite
- **Styling**: Tailwind CSS (Premium, Minimalist aesthetic)
- **Icons**: Lucide React
- **Audio Processing**: Web Audio API (AudioWorklet) for 16-bit PCM streaming.
- **Communication**: WebSockets (Low-latency duplex streaming).

### Backend
- **Runtime**: Node.js + TypeScript
- **Server**: Express (REST API) + `ws` (WebSocket Server)
- **AI Engine**: Gemini 2.5 Flash (Multimodal Live API)
- **External APIs**: 
  - **Google Trends API**: For real-time fashion insights.
  - **Pollinations.ai**: For dynamic style image generation.
- **Persistence**: 
  - Scoped by User ID.
  - Local JSON storage (fallback).
  - **Google Cloud Storage** support for scalable deployments.

---

## 🚀 Getting Started

### Prerequisites
- Node.js (v18+)
- A Google Cloud Project with the **Generative AI API** enabled.
- A **Google API Key**.

### Installation

1. **Clone the repository**:
   ```bash
   git clone https://github.com/your-repo/style-it.git
   cd style-it
   ```

2. **Setup Backend**:
   ```bash
   cd backend
   npm install
   # Create a .env file in the backend directory
   echo "GOOGLE_API_KEY=your_gemini_api_key_here" > .env
   npm run dev
   ```

3. **Setup Frontend**:
   ```bash
   cd ../frontend
   npm install
   npm run dev
   ```

4. **Access the App**:
   Open [http://localhost:5173](http://localhost:5173) in your browser.

---

## 🛠️ Environment Variables

### Backend (`backend/.env`)
| Variable | Description | Default |
|----------|-------------|---------|
| `GOOGLE_API_KEY` | Your Google AI (Gemini) API Key | **Required** |
| `GCS_BUCKET_NAME` | Google Cloud Storage Bucket for persistence | `siyw` |

---

## 📖 Usage Guide

1. **Sign In**: Create an account or log in to start your personalized journey.
2. **Connect AI**: Click the "Connect AI" button to establish a real-time multimodal session.
3. **Set your Goal**: Type or speak your desired aesthetic in the "Target Style" bar.
4. **Interact**: 
   - Turn on your camera to show your current outfit.
   - Upload an inspiration image.
   - Click "Analyze Now" to trigger a deep stylistic review.
5. **Shop & Save**: Browse the AI-generated recommendations, shop them on Google, or save them to your closet.

---

## 🛡️ Security & Privacy
- Style_it uses scoped user data for privacy.
- Audio and Video streams are processed in real-time and not stored unless explicitly requested by the session logic.
- Local persistence is handled via JSON files, while cloud persistence is secured through Google Cloud IAM.

---

*Style_it — Redefining your aesthetic journey with the power of Multimodal AI.*
