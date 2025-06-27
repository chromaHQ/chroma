import '@abraham/reflection';

import { create } from '@chroma/core';

create()
  .then(() => {
    console.log('Chroma wallet app started successfully ');
  })
  .catch((error) => {
    console.error('Failed to start Chroma wallet app:', error);
  });
