"use client";

import { useState, useEffect, useCallback } from "react";
import type { Question, GameStats } from "@/types/question";

const STORAGE_KEY = "tfgame_stats";

// Fisher-Yates shuffle
function shuffleArray<T>(array: T[]): T[] {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function loadStats(): GameStats {
  if (typeof window === "undefined") return { correct: 0, wrong: 0 };
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      return JSON.parse(saved);
    }
  } catch (e) {
    console.error("Failed to load stats:", e);
  }
  return { correct: 0, wrong: 0 };
}

function saveStats(stats: GameStats) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stats));
  } catch (e) {
    console.error("Failed to save stats:", e);
  }
}

export default function Home() {
  const [questions, setQuestions] = useState<Question[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [stats, setStats] = useState<GameStats>({ correct: 0, wrong: 0 });
  const [answered, setAnswered] = useState(false);
  const [isCorrect, setIsCorrect] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Load questions on mount
  useEffect(() => {
    async function fetchQuestions() {
      try {
        const res = await fetch("/questions.json");
        if (!res.ok) throw new Error("Failed to fetch questions");
        const data: Question[] = await res.json();
        setQuestions(shuffleArray(data));
        setLoading(false);
      } catch (e) {
        setError("Failed to load questions. Please refresh the page.");
        setLoading(false);
      }
    }
    fetchQuestions();
  }, []);

  // Load stats from localStorage on mount
  useEffect(() => {
    setStats(loadStats());
  }, []);

  const currentQuestion = questions[currentIndex];

  const handleAnswer = useCallback(
    (userAnswer: boolean) => {
      if (answered || !currentQuestion) return;

      const correct = userAnswer === currentQuestion.answer;
      setIsCorrect(correct);
      setAnswered(true);

      const newStats = {
        correct: stats.correct + (correct ? 1 : 0),
        wrong: stats.wrong + (correct ? 0 : 1),
      };
      setStats(newStats);
      saveStats(newStats);
    },
    [answered, currentQuestion, stats]
  );

  const handleNext = useCallback(() => {
    if (currentIndex < questions.length - 1) {
      setCurrentIndex(currentIndex + 1);
    } else {
      // Reshuffle and restart when all questions are done
      setQuestions(shuffleArray(questions));
      setCurrentIndex(0);
    }
    setAnswered(false);
    setIsCorrect(null);
  }, [currentIndex, questions]);

  if (loading) {
    return (
      <main className="min-h-screen flex items-center justify-center p-4">
        <div className="text-xl text-gray-600">Loading questions...</div>
      </main>
    );
  }

  if (error) {
    return (
      <main className="min-h-screen flex items-center justify-center p-4">
        <div className="text-xl text-red-600">{error}</div>
      </main>
    );
  }

  if (!currentQuestion) {
    return (
      <main className="min-h-screen flex items-center justify-center p-4">
        <div className="text-xl text-gray-600">No questions available.</div>
      </main>
    );
  }

  return (
    <main className="min-h-screen flex flex-col p-4 max-w-lg mx-auto">
      {/* Stats Header */}
      <header className="flex justify-end mb-6">
        <div className="text-sm sm:text-base text-gray-700 bg-white/80 backdrop-blur px-4 py-2 rounded-lg shadow">
          <span className="text-green-600 font-semibold">
            答对 {stats.correct} 题
          </span>
          <span className="mx-2 text-gray-400">|</span>
          <span className="text-red-500 font-semibold">
            答错 {stats.wrong} 题
          </span>
        </div>
      </header>

      {/* Question Area */}
      <section className="flex-1 flex flex-col">
        {/* Question Text */}
        <div className="bg-white rounded-2xl shadow-lg p-6 mb-6">
          <p className="text-lg sm:text-xl leading-relaxed text-gray-800">
            {currentQuestion.question}
          </p>
        </div>

        {/* True/False Buttons */}
        <div className="flex gap-4 mb-6">
          <button
            onClick={() => handleAnswer(true)}
            disabled={answered}
            className={`flex-1 py-4 px-6 rounded-xl text-lg font-bold transition-all duration-200 ${
              answered
                ? currentQuestion.answer === true
                  ? "bg-green-500 text-white"
                  : "bg-gray-200 text-gray-400"
                : "bg-green-500 hover:bg-green-600 active:bg-green-700 text-white shadow-lg hover:shadow-xl"
            } disabled:cursor-not-allowed`}
          >
            True
          </button>
          <button
            onClick={() => handleAnswer(false)}
            disabled={answered}
            className={`flex-1 py-4 px-6 rounded-xl text-lg font-bold transition-all duration-200 ${
              answered
                ? currentQuestion.answer === false
                  ? "bg-green-500 text-white"
                  : "bg-gray-200 text-gray-400"
                : "bg-red-500 hover:bg-red-600 active:bg-red-700 text-white shadow-lg hover:shadow-xl"
            } disabled:cursor-not-allowed`}
          >
            False
          </button>
        </div>

        {/* Result & Explanation */}
        {answered && (
          <div className="space-y-4 animate-fade-in">
            {/* Result Badge */}
            <div
              className={`text-center py-2 px-4 rounded-lg font-semibold ${
                isCorrect
                  ? "bg-green-100 text-green-700"
                  : "bg-red-100 text-red-700"
              }`}
            >
              {isCorrect ? "Correct!" : "Wrong!"}
            </div>

            {/* Explanation */}
            <div className="bg-blue-50 rounded-xl p-4 border border-blue-100">
              <p className="text-gray-700 leading-relaxed">
                {currentQuestion.explanation}
              </p>
            </div>

            {/* Next Button */}
            <button
              onClick={handleNext}
              className="w-full py-4 px-6 rounded-xl text-lg font-bold bg-yellow-400 hover:bg-yellow-500 active:bg-yellow-600 text-gray-800 shadow-lg hover:shadow-xl transition-all duration-200"
            >
              下一题
            </button>
          </div>
        )}
      </section>

      {/* Progress indicator */}
      <footer className="mt-6 text-center text-sm text-gray-500">
        Question {currentIndex + 1} of {questions.length}
      </footer>
    </main>
  );
}
