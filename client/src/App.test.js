import { render, screen } from '@testing-library/react';
import App from './App';

test('renders join screen', () => {
  render(<App />);
  expect(screen.getByText(/imposter word game/i)).toBeInTheDocument();
  expect(screen.getByPlaceholderText(/^name$/i)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /^join$/i })).toBeInTheDocument();
});
