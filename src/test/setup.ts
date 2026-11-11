import "@testing-library/jest-dom";

// The app defaults to offline mode (no network). Unit tests exercise the
// online paths unless a test switches the mode itself.
if (typeof localStorage !== "undefined") {
  localStorage.setItem("music_local_only", "0");
}
