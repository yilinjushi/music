export type Question = {
  id: number;
  question: string;
  answer: boolean;
  explanation: string;
};

export type GameStats = {
  correct: number;
  wrong: number;
};
