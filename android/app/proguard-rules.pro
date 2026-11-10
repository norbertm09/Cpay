# Lot Android P2 (audit 2026-11-02 P2-3) : plus de regles « garde-tout » sur retrofit2.**, okhttp3.**, gson.** et
# global.cpay.app.common.** — OkHttp 4.12, Retrofit 3 et Gson 2.13 livrent leurs regles consommateur ; seuls les
# modeles (classes portant des champs @SerializedName) sont conserves, avec obfuscation autorisee (Gson lit les
# annotations, pas les noms). Le build staging (R8 identique a la release) sert de recette avant chaque release.
-keepattributes Signature
-keepattributes *Annotation*
-keep,allowobfuscation class global.cpay.app.** { @com.google.gson.annotations.SerializedName <fields>; }
-keepclassmembers class global.cpay.app.** { @com.google.gson.annotations.SerializedName <fields>; <init>(...); }
# Reponses lues en Map<String, Any> / List<Map<..>> (ApiService) : types generiques des methodes de service
-keepclassmembers,allowobfuscation interface global.cpay.app.common.ApiService { <methods>; }

# Coroutines
-keepnames class kotlinx.coroutines.internal.MainDispatcherFactory {}
-keepnames class kotlinx.coroutines.CoroutineExceptionHandler {}

# ─── Classes optionnelles referencees par OkHttp/Retrofit/Gson mais absentes du classpath (R8 full mode les
#     traite en erreur « Missing class ») — release 2.7.1
-dontwarn org.bouncycastle.**
-dontwarn org.conscrypt.**
-dontwarn org.openjsse.**
-dontwarn javax.annotation.**
-dontwarn org.codehaus.mojo.animal_sniffer.*
-dontwarn kotlin.reflect.jvm.internal.**
-dontwarn java.lang.invoke.StringConcatFactory

# Gson : conserver les signatures generiques et les modeles (@SerializedName), TypeToken
-keepattributes Signature, InnerClasses, EnclosingMethod, RuntimeVisibleAnnotations, RuntimeVisibleParameterAnnotations
-keep class * extends com.google.gson.reflect.TypeToken
-keep,allowobfuscation,allowshrinking class com.google.gson.reflect.TypeToken
-keepclassmembers class * { @com.google.gson.annotations.SerializedName <fields>; }
-keepclassmembers,allowobfuscation class * { @com.google.gson.annotations.SerializedName <fields>; }

# Retrofit en R8 full mode : types generiques des interfaces de service et des suspend functions
-keep,allowobfuscation,allowshrinking interface retrofit2.Call
-keep,allowobfuscation,allowshrinking class retrofit2.Response
-keep,allowobfuscation,allowshrinking class kotlin.coroutines.Continuation
-if interface * { @retrofit2.http.* <methods>; }
-keep,allowobfuscation interface <1>

# Kotlin / coroutines
-dontwarn kotlinx.coroutines.**
-keepclassmembers class kotlinx.coroutines.** { volatile <fields>; }

# Bibliotheques UI tierces sans regles consommateur fiables
-dontwarn com.journeyapps.**
-dontwarn com.google.zxing.**
