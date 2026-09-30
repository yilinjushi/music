import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./assets/global.css";
import RootLayout from "./Layout";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { initializeLogger } from "./lib/logger";
import { clearRetiredSyncArtifacts } from "./lib/legacy-offline-cleanup";
import { purgeLegacyAlbumSheetRestoreSession } from "./lib/navigation/netease-detail-navigation";

initializeLogger();

async function bootstrap() {
  purgeLegacyAlbumSheetRestoreSession();
  // Retired sync credentials are capabilities. Purge them before any UI can
  // render, rather than relying on the optional delayed background chunk.
  await clearRetiredSyncArtifacts();

  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <ErrorBoundary>
        <RootLayout>
          <App />
        </RootLayout>
      </ErrorBoundary>
    </StrictMode>
  );
}

void bootstrap();
