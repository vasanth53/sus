import { render, screen } from '@testing-library/react';
import App from './App';

test('renders learn react link', () => {
  render(<App />);
  expect(screen.getByText(/imposter word game/i)).toBeInTheDocument();
  expect(screen.getByPlaceholderText(/enter your name/i)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /join game/i })).toBeInTheDocument();
});
