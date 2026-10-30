import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

const INITIAL_PREFERENCES = {
  essential: true,
  analytics: false,
  functional: false
};

export const useLegalStore = create(
  persist(
    (set) => ({
      cookiePreferences: INITIAL_PREFERENCES,
      hasAcceptedCookies: false,
      agreedToTermsVersion: 'v1.0',
      activeTab: 'terms',
      isLegalHubOpen: false,
      isCookieModalOpen: false,

      acceptAllCookies: () =>
        set({
          cookiePreferences: {
            essential: true,
            analytics: true,
            functional: true
          },
          hasAcceptedCookies: true,
          isCookieModalOpen: false
        }),

      acceptEssentialOnly: () =>
        set({
          cookiePreferences: {
            essential: true,
            analytics: false,
            functional: false
          },
          hasAcceptedCookies: true,
          isCookieModalOpen: false
        }),

      setCookiePreference: (key, value) =>
        set((state) => ({
          cookiePreferences: {
            ...state.cookiePreferences,
            [key]: key === 'essential' ? true : Boolean(value),
            essential: true
          }
        })),

      saveCookiePreferences: (preferences) =>
        set((state) => ({
          cookiePreferences: {
            ...state.cookiePreferences,
            ...preferences,
            essential: true
          },
          hasAcceptedCookies: true,
          isCookieModalOpen: false
        })),

      setAgreedToTermsVersion: (version) =>
        set({
          agreedToTermsVersion: version
        }),

      setActiveTab: (tabId) =>
        set({
          activeTab: tabId
        }),

      openLegalHub: (tabId = 'terms') =>
        set({
          activeTab: tabId,
          isLegalHubOpen: true
        }),

      closeLegalHub: () =>
        set({
          isLegalHubOpen: false
        }),

      openCookieModal: () =>
        set({
          isCookieModalOpen: true
        }),

      closeCookieModal: () =>
        set({
          isCookieModalOpen: false
        }),

      resetCookieConsent: () =>
        set({
          cookiePreferences: INITIAL_PREFERENCES,
          hasAcceptedCookies: false,
          isCookieModalOpen: true
        })
    }),
    {
      name: 'pryzmium_legal_trust_store_v1',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        cookiePreferences: state.cookiePreferences,
        hasAcceptedCookies: state.hasAcceptedCookies,
        agreedToTermsVersion: state.agreedToTermsVersion,
        activeTab: state.activeTab
      })
    }
  )
);
