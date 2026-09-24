import { configureStore } from '@reduxjs/toolkit';
import { serviceApi } from './service-api';

export const store = configureStore({
  reducer: { [serviceApi.reducerPath]: serviceApi.reducer },
  middleware: (getDefaultMiddleware) =>
    getDefaultMiddleware().concat(serviceApi.middleware),
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
