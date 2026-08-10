import { AppThemeProvider } from "@/components/ui/theme-provider";
import {
  lazy,
  Suspense,
  useEffect,
  useState,
  type PropsWithChildren,
} from "react";
import { Toaster } from "react-hot-toast";

const PWA_REGISTRATION_DELAY_MS = 5000;

const PwaUpdatePrompt = lazy(() =>
  import("@/components/PwaUpdatePrompt").then((module) => ({
    default: module.PwaUpdatePrompt,
  }))
);

export default function RootLayout({ children }: PropsWithChildren) {
  const [registerPwa, setRegisterPwa] = useState(false);

  useEffect(() => {
    // Installing the worker precaches the full application. Defer that
    // non-critical network work until the interactive shell is established.
    const timeoutId = window.setTimeout(
      () => setRegisterPwa(true),
      PWA_REGISTRATION_DELAY_MS
    );
    return () => window.clearTimeout(timeoutId);
  }, []);

  return (
    <AppThemeProvider attribute="class" enableSystem disableTransitionOnChange>
      {children}

      {registerPwa && (
        <Suspense fallback={null}>
          <PwaUpdatePrompt />
        </Suspense>
      )}

      <Toaster
        position="top-center"
        gutter={12}
        containerStyle={{
          top: "calc(24px + var(--safe-area-top))",
        }}
        toastOptions={{
          duration: 2000,
          style: {
            padding: "12px 16px",
            fontSize: "14px",
            borderRadius: "8px",
            maxWidth: "90%",
            margin: "0 auto",
          },
        }}
      />
    </AppThemeProvider>
  );
}
