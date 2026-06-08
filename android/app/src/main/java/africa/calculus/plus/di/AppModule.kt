package africa.calculus.plus.di

import africa.calculus.plus.BuildConfig
import africa.calculus.plus.data.api.ApiClientFactory
import africa.calculus.plus.data.api.CalculusApiService
import africa.calculus.plus.data.repository.*
import africa.calculus.plus.security.SecureStorage
import android.content.Context
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.components.SingletonComponent
import javax.inject.Singleton

@Module
@InstallIn(SingletonComponent::class)
object AppModule {

    @Provides @Singleton
    fun provideApiService(secureStorage: SecureStorage): CalculusApiService =
        ApiClientFactory.create { secureStorage.getAccessToken() }

    @Provides @Singleton
    fun providePaymentRepository(api: CalculusApiService, storage: SecureStorage) =
        PaymentRepository(api, storage)

    @Provides @Singleton
    fun provideMerchantRepository(api: CalculusApiService, storage: SecureStorage) =
        MerchantRepository(api, storage)

    @Provides @Singleton
    fun provideAuthRepository(api: CalculusApiService, storage: SecureStorage) =
        AuthRepository(api, storage)
}
