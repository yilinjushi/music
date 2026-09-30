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

function bootstrap() {
  purgeLegacyAlbumSheetRestoreSession();
  // Retired sync credentials are dead keys: purge them in the background so a
  // slow storage API never delays the first paint.
  void clearRetiredSyncArtifacts();

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
