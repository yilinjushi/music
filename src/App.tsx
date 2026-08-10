import { RouterProvider } from "react-router-dom";
import { lazy, Suspense, useEffect, useState } from "react";
import { router } from "./router";
import "./assets/global.css"; // Ensure styles are imported
import { PwaInstallPrompt } from "@/components/PwaInstallPrompt";

const AppBackgroundServices = lazy(() =>
  import("@/components/AppBackgroundServices").then((module) => ({
    default: module.AppBackgroundServices,
  }))
);

export default function App() {
  const [startBackgroundServices, setStartBackgroundServices] = useState(false);

  useEffect(() => {
    const timeoutId = setTimeout(() => setStartBackgroundServices(true), 5000);

    return () => {
      clearTimeout(timeoutId);
    };
  }, []);

  return (
    <>
      <RouterProvider router={router} />
      <PwaInstallPrompt />
      {startBackgroundServices && (
        <Suspense fallback={null}>
          <AppBackgroundServices />
        </Suspense>
      )}
    </>
  );
}
