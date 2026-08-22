import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { AccessPortal } from "./cloud/AccessPortal.js";
import { OAuthConsentPage } from "./cloud/OAuthConsentPage.js";
import { LearningCenter } from "./learning/LearningCenter.js";
import "./styles.css";

const root = document.getElementById("root");
if (root === null) throw new Error("Application root is missing.");
const route = window.location.pathname.replace(/\/+$/u, "") || "/";
const page = route === "/access"
  ? <AccessPortal />
  : route === "/learn"
    ? <LearningCenter />
    : route === "/oauth/consent"
      ? <OAuthConsentPage />
      : <App />;
createRoot(root).render(page);
