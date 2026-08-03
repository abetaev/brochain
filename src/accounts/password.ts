export interface PasswordStrength {
  score: number;
  label: string;
}

const labels = ["Very weak", "Weak", "Fair", "Strong", "Very strong"];

export function passwordStrength(password: string): PasswordStrength {
  if (password.length === 0) {
    return { score: 0, label: labels[0] };
  }

  let score = 0;

  if (password.length >= 12) {
    score += 1;
  }

  if (/[a-z]/.test(password) && /[A-Z]/.test(password)) {
    score += 1;
  }

  if (/\d/.test(password)) {
    score += 1;
  }

  if (/[^a-zA-Z\d]/.test(password)) {
    score += 1;
  }

  return { score, label: labels[score] };
}
