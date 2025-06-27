import { useCallback, useEffect, useRef, useState } from 'react';

export function useSetPassword() {
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [valid, setIsValid] = useState(false);

  const validatingTimeout = useRef<NodeJS.Timeout | null>(null);

  const handlePasswordChanged = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      setPassword(event.target.value);

      if (passwordError) {
        setPasswordError('');
      }
    },
    [passwordError],
  );

  const handleConfirmPasswordChanged = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      setConfirmPassword(event.target.value);

      if (passwordError) {
        setPasswordError('');
      }
    },
    [passwordError],
  );

  const debouncedValidatePassword = useCallback(() => {
    if (validatingTimeout.current) {
      clearTimeout(validatingTimeout.current);
    }

    const validate = () => {
      if (password && password.length < 8) {
        setPasswordError('Password must be at least 8 characters long');
      } else if (confirmPassword && confirmPassword !== password) {
        setPasswordError('Passwords do not match');
      } else {
        setPasswordError('');
      }

      setIsValid(password.length >= 8 && confirmPassword === password);
    };

    validatingTimeout.current = setTimeout(validate, 300);

    return () => {
      if (validatingTimeout.current) {
        clearTimeout(validatingTimeout.current);
      }
    };
  }, [confirmPassword, password]);

  useEffect(() => {
    debouncedValidatePassword();
  }, [password, confirmPassword, debouncedValidatePassword]);

  return {
    valid,
    password,
    confirmPassword,
    passwordError,

    setPassword: handlePasswordChanged,
    setConfirmPassword: handleConfirmPasswordChanged,
  };
}
