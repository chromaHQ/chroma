import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery } from '../useQuery';

export function useImportWalletValidation() {
  const [mnemonic, setMnemonic] = useState('');
  const [error, setError] = useState('');
  const [valid, setIsValid] = useState(false);

  const { run } = useQuery();
  const validatingTimeout = useRef<NodeJS.Timeout | null>(null);

  const handleMnemonicChanged = useCallback(
    (event: React.ChangeEvent<HTMLTextAreaElement>) => {
      setMnemonic(event.target.value);

      if (error) {
        setError('');
      }
    },
    [error],
  );

  const debounceValidateMnemonic = useCallback(() => {
    if (validatingTimeout.current) {
      clearTimeout(validatingTimeout.current);
    }

    const validate = async () => {
      const trimmedMnemonic = mnemonic.trim();

      if (trimmedMnemonic.split(' ').length === 12) {
        const res = await run<{ isValid: boolean }>('ValidateMnemonic', trimmedMnemonic);
        setIsValid(res.isValid);
        setError(res.isValid ? '' : 'Invalid mnemonic');
      } else if (trimmedMnemonic.split(' ').length > 12) {
        setIsValid(false);
        setError('Mnemonic should be 12 words long');
      } else {
        setIsValid(false);
      }
    };

    validatingTimeout.current = setTimeout(validate, 300);
    return () => {
      if (validatingTimeout.current) {
        clearTimeout(validatingTimeout.current);
      }
    };
  }, [mnemonic, run]);

  useEffect(() => {
    debounceValidateMnemonic();
  }, [debounceValidateMnemonic]);

  return {
    valid,
    mnemonic,
    error,

    setMnemonic: handleMnemonicChanged,
  };
}
