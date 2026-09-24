import { createApi, fetchBaseQuery } from '@reduxjs/toolkit/query/react';

export interface ReadinessResponse {
  status: 'ok';
  checks: { database: 'ok' };
}

export const serviceApi = createApi({
  reducerPath: 'serviceApi',
  baseQuery: fetchBaseQuery({
    baseUrl:
      import.meta.env.VITE_API_BASE_URL ??
      (import.meta.env.DEV ? 'http://localhost:3000/api/v1' : '/api/v1'),
  }),
  endpoints: (builder) => ({
    getReadiness: builder.query<ReadinessResponse, void>({
      query: () => '/health/ready',
    }),
  }),
});

export const { useGetReadinessQuery } = serviceApi;
